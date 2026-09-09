from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from email.parser import BytesParser
from email.policy import default as email_policy
from io import BytesIO
import json
from urllib.parse import parse_qs, unquote, urlparse

on_photo_recieve = []


def add_photo_listener(listener):
    on_photo_recieve.append(listener)


on_sample_complete_listeners = []


def add_sample_complete_listener(listener):
    on_sample_complete_listeners.append(listener)


on_manifest_listeners = []


def add_manifest_listener(listener):
    on_manifest_listeners.append(listener)


on_clear_listeners = []


def add_clear_listener(listener):
    on_clear_listeners.append(listener)


queue_status_provider = None
result_provider = None
v1_service = None


def set_queue_status_provider(provider):
    global queue_status_provider
    queue_status_provider = provider


def set_result_provider(provider):
    global result_provider
    result_provider = provider


def set_v1_service(service):
    global v1_service
    v1_service = service


class RawImage:
    def __init__(self, payload, name, tag, metadata=None):
        self.payload = payload
        self.file = payload
        self.name = name
        self.tag = tag
        self.metadata = metadata or {}

    def compressed(self):
        return ImageInfo(self.name, self.tag, self.metadata)


class ImageInfo:
    def __init__(self, name, tag, metadata=None):
        self.name = name
        self.tag = tag
        self.metadata = metadata or {}


class MultipartField:
    def __init__(self, payload, filename=None, content_type="application/octet-stream"):
        self.filename = filename
        self.type = content_type
        self.file = BytesIO(payload)
        self.value = payload.decode("utf-8", errors="replace")


def parse_multipart_form(handler, content_type):
    length = int(handler.headers.get("Content-Length", "0"))
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


class BakingRequestHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "3600")
        self.end_headers()
        self.wfile.write(body)

    def _send_binary(self, payload, digest, content_type="application/octet-stream"):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Cev-Digest", f"sha256:{digest}")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _handle_v1_error(self, error):
        from v1_service import BakeV1Error

        if isinstance(error, BakeV1Error):
            self._send_json(error.status, {"error": str(error), "code": error.code})
            return True
        return False

    def _v1_read_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0:
            return b""
        return self.rfile.read(length)

    def _handle_v1(self, method):
        from v1_service import BakeV1Error, parse_digest_header

        parsed = urlparse(self.path)
        if not parsed.path.startswith("/bake/v1"):
            return False
        if v1_service is None:
            self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {
                "error": "intrinsic-material-model@1 service is not configured",
                "code": "BAKE_PROVIDER_UNAVAILABLE",
            })
            return True

        parts = [part for part in parsed.path.split("/") if part]
        try:
            if method == "GET" and parts == ["bake", "v1", "capability"]:
                payload = json.dumps(v1_service.capability()).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(payload)
                return True
            if method == "POST" and parts == ["bake", "v1", "jobs"]:
                body = json.loads(self._v1_read_body().decode("utf-8") or "{}")
                result = v1_service.create_job(body.get("request") or {})
                self._send_json(HTTPStatus.OK, result)
                return True
            if len(parts) >= 4 and parts[:3] == ["bake", "v1", "jobs"]:
                job_id = unquote(parts[3])
                rest = parts[4:]
                if method == "PUT" and rest[:1] == ["inputs"] and len(rest) == 2:
                    key = unquote(rest[1])
                    sample_id, view_id, role = key.split(":", 2)
                    payload = self._v1_read_body()
                    declared = int(self.headers.get("Content-Length", "0"))
                    if declared != len(payload):
                        raise BakeV1Error("BAKE_TRANSFER_DIGEST_MISMATCH", "Transfer length does not match Content-Length.")
                    digest = parse_digest_header(self.headers.get("X-Cev-Digest"))
                    sample_id = self.headers.get("X-Cev-Sample-Id") or sample_id
                    view_id = self.headers.get("X-Cev-View-Id") or view_id
                    role = self.headers.get("X-Cev-Role") or role
                    result = v1_service.upload_input(job_id, sample_id, view_id, role, payload, digest)
                    self._send_json(HTTPStatus.OK, result)
                    return True
                if method == "POST" and rest == ["submit"]:
                    body = json.loads(self._v1_read_body().decode("utf-8") or "{}")
                    result = v1_service.submit(job_id, body.get("requestHash") or "")
                    self._send_json(HTTPStatus.OK, result)
                    return True
                if method == "GET" and rest == ["status"]:
                    self._send_json(HTTPStatus.OK, v1_service.status(job_id))
                    return True
                if method == "GET" and rest == ["result"]:
                    self._send_json(HTTPStatus.OK, v1_service.result(job_id))
                    return True
                if method == "GET" and rest[:1] == ["buffers"] and len(rest) == 2:
                    payload, digest = v1_service.buffer(job_id, unquote(rest[1]))
                    self._send_binary(payload, digest)
                    return True
                if method == "POST" and rest == ["cancel"]:
                    if int(self.headers.get("Content-Length", "0")):
                        self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    self._send_json(HTTPStatus.OK, v1_service.cancel(job_id))
                    return True
        except BakeV1Error as error:
            self._handle_v1_error(error)
            return True
        except json.JSONDecodeError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid json", "code": "BAKE_CONTRACT_INVALID"})
            return True
        return False

    def _send_png(self, payload):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _send_cors_preflight(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Cev-Digest, X-Cev-Sample-Id, X-Cev-View-Id, X-Cev-Role")
        self.send_header("Access-Control-Max-Age", "3600")
        self.end_headers()

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        self._send_cors_preflight()

    def do_GET(self):
        if self._handle_v1("GET"):
            return

        if self.path == "/healthz":
            self._send_json(HTTPStatus.OK, {"success": True})
            return

        if self.path == "/clear":
            for listener in on_clear_listeners:
                listener()
            self._send_json(HTTPStatus.OK, {"success": True})
            return

        if self.path == "/queue":
            payload = queue_status_provider() if queue_status_provider else {
                "queuedSamples": 0,
                "pendingSamples": 0,
                "pending": [],
            }
            self._send_json(HTTPStatus.OK, payload)
            return

        if self.path.startswith("/bake/result"):
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            sample_id = (params.get("sampleId") or [""])[0]
            view_id = (params.get("viewId") or [""])[0]

            if not sample_id or not view_id:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing sampleId or viewId"})
                return

            if not result_provider:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "result provider unavailable"})
                return

            result = result_provider(sample_id, view_id)
            status = result.get("status")

            if status == "ready":
                path = result.get("path")
                try:
                    with open(path, "rb") as f:
                        payload = f.read()
                except OSError:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "result file missing"})
                    return
                self._send_png(payload)
                return

            if status == "pending":
                self.send_response(HTTPStatus.ACCEPTED)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "pending"}).encode("utf-8"))
                return

            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_PUT(self):
        if self._handle_v1("PUT"):
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self):
        if self._handle_v1("POST"):
            return

        if self.path == "/bake/complete":
            try:
                payload = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid json"})
                return

            for listener in on_sample_complete_listeners:
                listener(payload)
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        if self.path == "/bake/manifest":
            try:
                payload = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid json"})
                return

            for listener in on_manifest_listeners:
                listener(payload)
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        if self.path != "/bake":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        content_type = self.headers.get("Content-Type", "")
        if content_type.startswith("multipart/form-data"):
            form = parse_multipart_form(self, content_type)
            photo = form.get("photo")
            if photo is None or not getattr(photo, "file", None):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing photo"})
                return

            payload = photo.file.read()
            metadata = {}
            for key in form.keys():
                if key == "photo":
                    continue
                field = form[key]
                metadata[key] = field.value if hasattr(field, "value") else str(field)

            raw_image = RawImage(payload, photo.filename, photo.type, metadata)
            for listener in on_photo_recieve:
                listener(raw_image)
        else:
            length = int(self.headers.get("Content-Length", "0"))
            if length:
                self.rfile.read(length)

        self._send_json(HTTPStatus.OK, {"ok": True})

    def log_message(self, format, *args):
        return


def begin_server_async():
    print("Syncing...")
    import threading

    thread = threading.Thread(target=main, daemon=True)
    thread.start()
    return thread


def main():
    try:
        from backends import load_backend
        from v1_service import BakeV1Service

        set_v1_service(BakeV1Service(backend=load_backend()))
        print("VIS-11 intrinsic-material-model@1 listening at /bake/v1")
    except Exception as exc:
        print(f"VIS-11 v1 service disabled: {exc}")
    server = ThreadingHTTPServer(("0.0.0.0", 8000), BakingRequestHandler)
    print("Baking API listening on http://0.0.0.0:8000")
    server.serve_forever()


if __name__ == "__main__":
    main()
