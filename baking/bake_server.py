from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from email.parser import BytesParser
from email.policy import default as email_policy
from io import BytesIO
import json
from urllib.parse import parse_qs, urlparse

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


def set_queue_status_provider(provider):
    global queue_status_provider
    queue_status_provider = provider


def set_result_provider(provider):
    global result_provider
    result_provider = provider


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
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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

    def do_POST(self):
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
    server = ThreadingHTTPServer(("0.0.0.0", 8000), BakingRequestHandler)
    print("Baking API listening on http://0.0.0.0:8000")
    server.serve_forever()


if __name__ == "__main__":
    main()
