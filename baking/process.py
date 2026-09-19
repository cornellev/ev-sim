from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from email.parser import BytesParser
from email.policy import default as email_policy
from io import BytesIO
import hmac
import json
import os
import traceback
from urllib.parse import urlparse


MODEL_ID = os.environ.get("BAKE_PROCESS_MODEL")
SERVER_HOST = os.environ.get("BAKE_PROCESS_HOST", "127.0.0.1")
SERVER_PORT = int(os.environ.get("BAKE_PROCESS_PORT", "8001"))
LEGACY_IMAGE_FILL = os.environ.get("BAKE_LEGACY_IMAGE_FILL") == "1"
MAX_PROCESS_BYTES = int(os.environ.get("BAKE_PROCESS_MAX_BYTES", str(64 * 1024 * 1024)))

_pipe = None
_torch = None


class MultipartField:
    def __init__(self, payload, filename=None, content_type="application/octet-stream"):
        self.filename = filename
        self.type = content_type
        self.file = BytesIO(payload)
        self.value = payload.decode("utf-8", errors="replace")


def parse_multipart_form(handler, content_type):
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0 or length > MAX_PROCESS_BYTES:
        raise ValueError("legacy process request length is invalid or too large")
    body = handler.rfile.read(length)
    header = (
        f"Content-Type: {content_type}\r\n"
        "MIME-Version: 1.0\r\n\r\n"
    ).encode("utf-8")
    message = BytesParser(policy=email_policy).parsebytes(header + body)
    fields = {}

    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        payload = part.get_payload(decode=True) or b""
        fields[name] = MultipartField(
            payload,
            filename=part.get_filename(),
            content_type=part.get_content_type(),
        )

    return fields


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
    if not LEGACY_IMAGE_FILL:
        raise RuntimeError("legacy image-fill is disabled unless BAKE_LEGACY_IMAGE_FILL=1")
    if not MODEL_ID:
        raise RuntimeError("legacy image-fill requires an explicit BAKE_PROCESS_MODEL pin")

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
    def _host_allowed(self):
        try:
            host = (urlparse(f"//{self.headers.get('Host', '')}").hostname or "").lower().rstrip(".")
        except ValueError:
            return False
        configured = {
            value.strip().lower().rstrip(".")
            for value in os.environ.get("BAKE_PROCESS_ALLOWED_HOSTS", "").split(",")
            if value.strip()
        }
        return host in {"localhost", "127.0.0.1", "::1"} | configured

    def _origin(self):
        origin = self.headers.get("Origin", "").strip()
        allowed = {
            value.strip()
            for value in os.environ.get(
                "BAKE_PROCESS_ALLOWED_ORIGINS",
                "http://localhost:3000,http://127.0.0.1:3000,http://[::1]:3000",
            ).split(",")
            if value.strip()
        }
        return origin if origin and origin in allowed else None

    def _cors(self):
        origin = self._origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _authorized(self):
        token = os.environ.get("BAKE_PROCESS_TOKEN") or os.environ.get("CEV_SIM_BAKE_TOKEN", "")
        supplied = self.headers.get("Authorization", "")
        return bool(token) and hmac.compare_digest(supplied, f"Bearer {token}")

    def _send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_png(self, payload):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        if not self._host_allowed() or (self.headers.get("Origin") and not self._origin()):
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "origin is not allowed"})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

    def do_GET(self):
        if not self._host_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "host is not allowed"})
            return
        if self.path == "/healthz":
            self._send_json(HTTPStatus.OK, {"success": True})
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self):
        if not self._host_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "host is not allowed"})
            return
        if not self._authorized():
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "valid bake authorization is required"})
            return
        if self.path != "/process":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "expected multipart/form-data"})
            return

        try:
            form = parse_multipart_form(self, content_type)
        except (TypeError, ValueError) as error:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": str(error)})
            return

        image = form.get("image")
        mask = form.get("mask")
        if image is None or mask is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing image or mask"})
            return

        tag_field = form.get("tag")
        tag = tag_field.value if tag_field is not None else "default"

        metadata_field = form.get("metadata")
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
    if not LEGACY_IMAGE_FILL:
        raise SystemExit(
            "process.py legacy image-fill is disabled and non-promotable. "
            "Use bake_server.py /bake/v1 with a pinned fake or operator-injected backend.",
        )
    if not MODEL_ID:
        raise SystemExit("BAKE_LEGACY_IMAGE_FILL requires BAKE_PROCESS_MODEL")
    if SERVER_HOST not in {"localhost", "127.0.0.1", "::1"} and os.environ.get("BAKE_PROCESS_ALLOW_REMOTE") != "1":
        raise SystemExit("non-loopback legacy process binding requires BAKE_PROCESS_ALLOW_REMOTE=1")
    if not (os.environ.get("BAKE_PROCESS_TOKEN") or os.environ.get("CEV_SIM_BAKE_TOKEN")):
        raise SystemExit("BAKE_PROCESS_TOKEN or CEV_SIM_BAKE_TOKEN is required")
    server = ThreadingHTTPServer((SERVER_HOST, SERVER_PORT), ProcessRequestHandler)
    print(f"Bake processing API listening on http://{SERVER_HOST}:{SERVER_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
