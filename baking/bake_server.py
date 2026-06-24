from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import cgi
import json

on_photo_recieve = []


def add_photo_listener(listener):
    on_photo_recieve.append(listener)


on_sample_complete_listeners = []


def add_sample_complete_listener(listener):
    on_sample_complete_listeners.append(listener)


on_clear_listeners = []


def add_clear_listener(listener):
    on_clear_listeners.append(listener)


queue_status_provider = None


def set_queue_status_provider(provider):
    global queue_status_provider
    queue_status_provider = provider


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

        if self.path != "/bake":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        content_type = self.headers.get("Content-Type", "")
        if content_type.startswith("multipart/form-data"):
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": content_type,
                },
            )
            photo = form["photo"] if "photo" in form else None
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
