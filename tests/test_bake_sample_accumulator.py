import importlib.util
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


class BakeSampleAccumulatorTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.previous_cwd = os.getcwd()
        os.chdir(self.tempdir.name)
        self.baking = load_baking_module()
        self.baking.pending_samples.clear()
        self.baking.queue.clear()

    def tearDown(self):
        os.chdir(self.previous_cwd)
        self.tempdir.cleanup()

    def _photo(self, metadata, name="render_beauty_view.png"):
        class RawPhoto:
            def __init__(self):
                self.payload = b"png-bytes"
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
        }, "mask_mask_building_bake_view_main.png"))

        self.assertEqual(len(self.baking.queue), 1)
        self.baking.process()

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["tag"], "building")
        self.assertTrue(calls[0]["image_path"].endswith("render_beauty_bake_view_main.png"))
        self.assertTrue(calls[0]["mask_path"].endswith("mask_mask_building_bake_view_main.png"))
        self.assertEqual(calls[0]["metadata"]["sampleId"], "run-c:5")
        self.assertTrue(os.path.exists("baked/run-c/00005/final_bake_view_main.png"))


if __name__ == "__main__":
    unittest.main()
