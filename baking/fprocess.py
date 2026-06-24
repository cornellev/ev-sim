import json
import os
import uuid
from urllib import error, request


SERVER_HOST = os.environ.get("BAKE_PROCESS_SERVER", "http://localhost:8001")
SERVER_ENDPOINT = os.environ.get("BAKE_PROCESS_ENDPOINT", f"{SERVER_HOST}/process")


def _multipart_body(fields, files):
    boundary = f"----sensor-fusion-bake-{uuid.uuid4().hex}"
    chunks = []

    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode("utf-8"),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
            str(value).encode("utf-8"),
            b"\r\n",
        ])

    for name, file_info in files.items():
        filename, payload, content_type = file_info
        chunks.extend([
            f"--{boundary}\r\n".encode("utf-8"),
            (
                f'Content-Disposition: form-data; name="{name}"; '
                f'filename="{filename}"\r\n'
            ).encode("utf-8"),
            f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
            payload,
            b"\r\n",
        ])

    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return boundary, b"".join(chunks)


def _read_file(path):
    with open(path, "rb") as f:
        return f.read()


def process_image(image_path, mask_path, tag, save_path=None, metadata=None):
    """Send one image/mask/tag job to the external processing server.

    Returns the saved output path on success, otherwise None.
    """
    output_path = save_path or f"baked_{tag}.png"
    fields = {
        "tag": tag,
        "metadata": json.dumps(metadata or {}),
    }
    files = {
        "image": (os.path.basename(image_path), _read_file(image_path), "image/png"),
        "mask": (os.path.basename(mask_path), _read_file(mask_path), "image/png"),
    }
    boundary, body = _multipart_body(fields, files)

    req = request.Request(
        SERVER_ENDPOINT,
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
    )

    try:
        with request.urlopen(req, timeout=600) as response:
            result = response.read()
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"Error processing image: {exc.code} - {body}")
        return None
    except error.URLError as exc:
        print(f"Error processing image: {exc.reason}")
        return None

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(result)
    return output_path