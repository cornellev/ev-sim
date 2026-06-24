from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import cgi
import json
import os
import traceback


MODEL_ID = os.environ.get("BAKE_PROCESS_MODEL", "black-forest-labs/FLUX.1-Fill-dev")
SERVER_HOST = os.environ.get("BAKE_PROCESS_HOST", "0.0.0.0")
SERVER_PORT = int(os.environ.get("BAKE_PROCESS_PORT", "8001"))

_pipe = None
_torch = None


PROMPTS = {
    "building": {
        "prompt": (
            "Realistic modern downtown buildings, glass windows, brick, stone, "
            "concrete, metal facades, entrances, daylight, natural shadows, "
            "real city photograph."
        ),
        "prompt_2": """
Transform only the masked building surfaces into believable real-world city architecture.

Preserve the camera angle, perspective, building footprints, building heights, silhouettes,
and street layout. Do not move the buildings or change the road geometry.

Replace the low-poly placeholder facades with realistic urban buildings: aligned windows,
glass reflections, brick, stone, concrete panels, metal trim, entrance doors, rooftop details,
realistic scale, and natural architectural variation.

Avoid gray concrete monoliths, abandoned buildings, dirty grunge textures, melted facades,
distorted windows, flat shading, low-poly geometry, CGI, clay render, and stylized game assets.
""",
    },
    "no_road_building": {
        "prompt": (
            "Photorealistic city surroundings, sidewalks, street furniture, traffic signs, "
            "vegetation, sky, daylight, natural photographic detail."
        ),
        "prompt_2": """
Transform only the masked non-road and non-building areas into believable real-world city
context while preserving the road layout and building silhouettes. Add realistic sidewalks,
curbs, signs, street furniture, background detail, sky, lighting, and natural material response.

Do not overwrite the road surface. Do not alter building footprints or facades. Avoid CGI,
low-poly artifacts, warped geometry, and stylized game-asset appearance.
""",
    },
}


def _normalize_tag(tag):
    tag = (tag or "default").strip().lower()
    if tag in {"buildings", "mask_building"}:
        return "building"
    if tag in {"mask_no_road_building", "road_building_negative"}:
        return "no_road_building"
    return tag


def _prompt_config(tag):
    normalized = _normalize_tag(tag)
    return PROMPTS.get(normalized, {
        "prompt": (
            "Realistic modern city street photograph, urban architecture, "
            "clear daylight, natural shadows, not CGI."
        ),
        "prompt_2": (
            "Transform only the masked area into a believable real-life city street "
            "photograph while preserving perspective, layout, object positions, and scale. "
            "Avoid low-poly, flat-shaded, stylized, or CGI appearance."
        ),
    })


def _load_pipeline():
    global _pipe, _torch
    if _pipe is not None:
        return _pipe

    import torch
    from diffusers import FluxFillPipeline

    _torch = torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32

    pipe = FluxFillPipeline.from_pretrained(MODEL_ID, torch_dtype=dtype).to(device)

    if hasattr(pipe, "tokenizer") and pipe.tokenizer is not None:
        pipe.tokenizer.clean_up_tokenization_spaces = False
    if hasattr(pipe, "tokenizer_2") and pipe.tokenizer_2 is not None:
        pipe.tokenizer_2.clean_up_tokenization_spaces = False

    if device == "cuda":
        torch.backends.cudnn.benchmark = True
        torch.set_float32_matmul_precision("high")

    _pipe = pipe
    return _pipe


def _pipeline_dimensions(image):
    width, height = image.size
    rounded_width = max(16, width - (width % 16))
    rounded_height = max(16, height - (height % 16))
    return rounded_width, rounded_height


def _process_pil_image(image, mask, tag, seed=None):
    from PIL import Image

    image = image.convert("RGB")
    mask = mask.convert("L")
    original_size = image.size
    width, height = _pipeline_dimensions(image)

    if (width, height) != original_size:
        image = image.resize((width, height), Image.Resampling.LANCZOS)
        mask = mask.resize((width, height), Image.Resampling.NEAREST)

    if os.environ.get("BAKE_PROCESS_FAKE") == "1":
        # Useful for testing the request path without loading the model.
        return image.resize(original_size, Image.Resampling.LANCZOS)

    pipe = _load_pipeline()
    torch = _torch
    config = _prompt_config(tag)
    if seed is None:
        seed = int(os.environ.get("BAKE_PROCESS_SEED", "2"))

    result = pipe(
        prompt=config["prompt"],
        prompt_2=config["prompt_2"],
        image=image,
        mask_image=mask,
        height=height,
        width=width,
        guidance_scale=float(os.environ.get("BAKE_PROCESS_GUIDANCE", "14")),
        num_inference_steps=int(os.environ.get("BAKE_PROCESS_STEPS", "36")),
        max_sequence_length=int(os.environ.get("BAKE_PROCESS_MAX_SEQUENCE", "512")),
        generator=torch.Generator("cpu").manual_seed(int(seed)),
    ).images[0]

    if result.size != original_size:
        result = result.resize(original_size, Image.Resampling.LANCZOS)
    return result


def process_image(image_path, mask_path, tag, save_path=None, seed=None):
    from PIL import Image

    image = Image.open(image_path)
    mask = Image.open(mask_path)
    result = _process_pil_image(image, mask, tag, seed=seed)
    if save_path:
        os.makedirs(os.path.dirname(save_path) or ".", exist_ok=True)
        result.save(save_path)
    return result


def process_image_bytes(image_bytes, mask_bytes, tag, seed=None):
    from PIL import Image

    image = Image.open(BytesIO(image_bytes))
    mask = Image.open(BytesIO(mask_bytes))
    return _process_pil_image(image, mask, tag, seed=seed)


class ProcessRequestHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _send_png(self, payload):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/healthz":
            self._send_json(HTTPStatus.OK, {"success": True})
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self):
        if self.path != "/process":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "expected multipart/form-data"})
            return

        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": content_type,
            },
        )

        image = form["image"] if "image" in form else None
        mask = form["mask"] if "mask" in form else None
        if image is None or mask is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing image or mask"})
            return

        tag_field = form["tag"] if "tag" in form else None
        tag = tag_field.value if tag_field is not None else "default"

        metadata_field = form["metadata"] if "metadata" in form else None
        metadata = {}
        if metadata_field is not None and metadata_field.value:
            try:
                metadata = json.loads(metadata_field.value)
            except json.JSONDecodeError:
                metadata = {}

        model_seed = metadata.get("modelSeed")
        seed = int(model_seed) if model_seed is not None else None

        try:
            result = process_image_bytes(
                image.file.read(),
                mask.file.read(),
                tag,
                seed=seed,
            )
            output = BytesIO()
            result.save(output, format="PNG")
            self._send_png(output.getvalue())
        except Exception as exc:
            traceback.print_exc()
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": str(exc), "tag": tag},
            )

    def log_message(self, format, *args):
        return


def main():
    server = ThreadingHTTPServer((SERVER_HOST, SERVER_PORT), ProcessRequestHandler)
    print(f"Bake processing API listening on http://{SERVER_HOST}:{SERVER_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()