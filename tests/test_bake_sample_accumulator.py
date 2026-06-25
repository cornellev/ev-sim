import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BAKING_DIR = ROOT / "baking"


def load_baking_module():
    sys.path.insert(0, str(BAKING_DIR))
    spec = importlib.util.spec_from_file_location("baking_module", BAKING_DIR / "baking.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_gs_export():
    sys.path.insert(0, str(BAKING_DIR))
    spec = importlib.util.spec_from_file_location("gs_export_module", BAKING_DIR / "gs_export.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class BakeSampleAccumulatorTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.previous_cwd = os.getcwd()
        os.chdir(self.tempdir.name)
        self.baking = load_baking_module()
        self.baking.pending_samples.clear()
        self.baking.processing_samples.clear()
        self.baking.queue.clear()
        self.baking.run_manifests.clear()
        self.baking.building_bake_state.clear()
        self.baking.sample_results.clear()

    def tearDown(self):
        os.chdir(self.previous_cwd)
        self.tempdir.cleanup()

    def _photo(self, metadata, name="render_beauty_view.png", payload=b"png-bytes"):
        class RawPhoto:
            def __init__(self):
                self.payload = payload
                self.name = name
                self.metadata = metadata

        return RawPhoto()

    def test_groups_files_into_one_sample_job(self):
        metadata = {
            "runId": "run-a",
            "frameIndex": "3",
            "sampleId": "run-a:3",
            "viewId": "bake/view/main",
            "expectedFiles": "3",
        }

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "render",
            "passId": "beauty",
        }, "render_beauty_bake_view_main.png"))

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "mask",
            "passId": "mask_road",
        }, "mask_mask_road_bake_view_main.png"))

        self.assertEqual(len(self.baking.queue), 0)

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "mask",
            "passId": "mask_building",
        }, "mask_mask_building_bake_view_main.png"))

        self.assertEqual(len(self.baking.queue), 1)
        job = self.baking.queue[0]
        self.assertEqual(job.sample_id, "run-a:3")
        self.assertEqual(len(job.files), 3)
        self.assertTrue(os.path.exists(job.files[0].path))

    def test_sample_complete_finalizes_partial_accumulator(self):
        metadata = {
            "runId": "run-b",
            "frameIndex": "1",
            "sampleId": "run-b:1",
            "viewId": "bake/view/main",
        }

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "render",
            "passId": "beauty",
            "expectedFiles": "1",
        }))

        self.assertEqual(len(self.baking.queue), 1)

        self.baking.queue.clear()
        self.baking.pending_samples.clear()

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "render",
            "passId": "beauty",
            "expectedFiles": "2",
        }))
        self.assertEqual(len(self.baking.queue), 0)

        self.baking.on_sample_complete({
            "runId": "run-b",
            "frameIndex": "1",
            "sampleId": "run-b:1",
            "expectedFiles": "2",
        })
        self.assertEqual(len(self.baking.queue), 0)

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "mask",
            "passId": "mask_road",
            "expectedFiles": "2",
        }, "mask_mask_road_bake_view_main.png"))

        self.assertEqual(len(self.baking.queue), 1)

    def test_process_routes_sample_masks_through_fprocess(self):
        metadata = {
            "runId": "run-c",
            "frameIndex": "5",
            "sampleId": "run-c:5",
            "viewId": "bake/view/main",
            "expectedFiles": "2",
        }
        calls = []

        def fake_process_image(image_path, mask_path, tag, save_path=None, metadata=None):
            calls.append({
                "image_path": image_path,
                "mask_path": mask_path,
                "tag": tag,
                "save_path": save_path,
                "metadata": metadata,
            })
            with open(save_path, "wb") as f:
                f.write(b"processed")
            return save_path

        self.baking.fprocess.process_image = fake_process_image

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "render",
            "passId": "beauty",
        }, "render_beauty_bake_view_main.png"))
        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "mask",
            "passId": "mask_building",
            "maskTags": "building",
            "buildingId": "bldg-1",
            "modelSeed": "12345",
        }, "mask_mask_building_bake_view_main.png", payload=b"x" * 256))

        self.assertEqual(len(self.baking.queue), 1)
        self.baking.process()

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["tag"], "building")
        self.assertEqual(calls[0]["metadata"]["modelSeed"], "12345")
        self.assertTrue(calls[0]["image_path"].endswith("render_beauty_bake_view_main.png"))
        self.assertTrue(calls[0]["mask_path"].endswith("mask_mask_building_bake_view_main.png"))
        self.assertEqual(calls[0]["metadata"]["sampleId"], "run-c:5")
        self.assertTrue(os.path.exists("baked/run-c/00005/final_bake_view_main.png"))
        self.assertTrue(os.path.exists("baked/run-c/00005/meta.json"))
        self.assertTrue(os.path.exists("baked/run-c/frames.jsonl"))

    def test_processing_sample_result_stays_pending(self):
        job = self.baking.SampleJob(
            sample_id="run-processing:1",
            run_id="run-processing",
            frame_index=1,
        )
        self.baking.processing_samples[job.sample_id] = job

        result = self.baking.get_sample_result("run-processing:1", "bake/view/main")

        self.assertEqual(result["status"], "pending")

    def test_process_runs_only_one_model_call_when_chain_disabled(self):
        metadata = {
            "runId": "run-d",
            "frameIndex": "2",
            "sampleId": "run-d:2",
            "viewId": "bake/view/main",
            "expectedFiles": "3",
        }
        calls = []

        def fake_process_image(image_path, mask_path, tag, save_path=None, metadata=None):
            calls.append(tag)
            with open(save_path, "wb") as f:
                f.write(b"processed")
            return save_path

        self.baking.fprocess.process_image = fake_process_image

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "render",
            "passId": "beauty",
        }, "render_beauty_bake_view_main.png"))
        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "mask",
            "passId": "mask_building",
            "maskTags": "building",
            "chainProcess": "0",
        }, "mask_mask_building_bake_view_main.png", payload=b"x" * 256))
        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "mask",
            "passId": "mask_no_road_building",
            "maskTags": "no_road_building",
            "chainProcess": "0",
        }, "mask_mask_no_road_building_bake_view_main.png", payload=b"x" * 256))

        self.baking.process()
        self.assertEqual(calls, ["building"])

    def test_manifest_persistence(self):
        payload = {
            "runId": "run-manifest",
            "environmentId": "igvc",
            "seed": 42,
            "buildings": [{"buildingId": "bldg-1"}],
        }
        self.baking.on_manifest(payload)
        self.assertTrue(os.path.exists("baked/run-manifest/manifest.json"))
        with open("baked/run-manifest/manifest.json", "r", encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["seed"], 42)
        self.assertEqual(saved["buildings"][0]["buildingId"], "bldg-1")

    def test_lidar_and_depth_roles_are_preserved(self):
        metadata = {
            "runId": "run-e",
            "frameIndex": "4",
            "sampleId": "run-e:4",
            "viewId": "bake/view/main",
            "expectedFiles": "3",
        }

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "render",
            "passId": "beauty",
        }))
        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "lidar",
            "passId": "lidar",
        }, "lidar_range_bake_view_main.bin", payload=b"\x00\x00\x00\x00"))
        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "depth",
            "passId": "depth",
        }, "depth_bake_view_main.png"))

        job = self.baking.queue[0]
        roles = {sample.file_role for sample in job.files}
        self.assertEqual(roles, {"render", "lidar", "depth"})

    def test_get_sample_result_ready_after_processing(self):
        metadata = {
            "runId": "run-f",
            "frameIndex": "8",
            "sampleId": "run-f:8",
            "viewId": "bake/view/main",
            "expectedFiles": "1",
        }

        self.baking.fprocess.process_image = lambda *args, **kwargs: None

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "render",
            "passId": "beauty",
        }, "render_beauty_bake_view_main.png"))

        self.assertEqual(len(self.baking.queue), 1)
        self.baking.process()

        result = self.baking.get_sample_result("run-f:8", "bake/view/main")
        self.assertEqual(result["status"], "ready")
        self.assertTrue(os.path.exists(result["path"]))

    def test_get_sample_result_pending_while_accumulating(self):
        metadata = {
            "runId": "run-g",
            "frameIndex": "1",
            "sampleId": "run-g:1",
            "viewId": "bake/view/main",
            "expectedFiles": "2",
        }

        self.baking.on_photo(self._photo({
            **metadata,
            "fileRole": "render",
            "passId": "beauty",
        }))

        result = self.baking.get_sample_result("run-g:1", "bake/view/main")
        self.assertEqual(result["status"], "pending")


class GaussianSplatExportTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.previous_cwd = os.getcwd()
        os.chdir(self.tempdir.name)
        self.gs_export = load_gs_export()

    def tearDown(self):
        os.chdir(self.previous_cwd)
        self.tempdir.cleanup()

    def test_builds_transforms_from_frames_log(self):
        run_id = "run-gs"
        run_dir = Path("baked") / run_id
        run_dir.mkdir(parents=True)

        with open(run_dir / "manifest.json", "w", encoding="utf-8") as f:
            json.dump({"runId": run_id, "seed": 7, "buildings": []}, f)

        frame_record = {
            "sampleId": f"{run_id}:0",
            "runId": run_id,
            "frameIndex": 0,
            "metadata": {
                "cameraIntrinsics": json.dumps({
                    "width": 100,
                    "height": 50,
                    "fx": 50,
                    "fy": 50,
                }),
                "cameraExtrinsics": json.dumps({
                    "position": {"x": 0, "y": 1, "z": 2},
                    "rotation": {"x": 0, "y": 0, "z": 0},
                    "matrixWorld": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                }),
            },
            "final": {
                "bake/view/main": str(run_dir / "00000" / "final_bake_view_main.png"),
            },
            "aux": [],
        }

        with open(run_dir / "frames.jsonl", "w", encoding="utf-8") as f:
            f.write(json.dumps(frame_record) + "\n")

        output = self.gs_export.update_transforms_for_run(run_id)
        self.assertTrue(output.exists())
        with open(output, "r", encoding="utf-8") as f:
            transforms = json.load(f)
        self.assertEqual(transforms["run_id"], run_id)
        self.assertEqual(len(transforms["frames"]), 1)
        self.assertEqual(transforms["frames"][0]["frame_index"], 0)


if __name__ == "__main__":
    unittest.main()
