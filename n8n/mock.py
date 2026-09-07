import http.server, socketserver, json

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.respond()
    def do_POST(self): self.respond()
    def do_DELETE(self): self.respond()
    def do_PUT(self): self.respond()

    def respond(self):
        print(f"[{self.command}] {self.path}", flush=True)
        self.send_response(200)
        
        if "exec" in self.path.lower():
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            # 官方 Zod Schema 要求的字段：stdout 使用 message，exit 使用 exitCode
            events = [
                {"type": "stdout", "message": "ok\n"},
                {"type": "exit", "exitCode": 0}
            ]
            body = "\n".join(json.dumps(e) for e in events) + "\n"
            self.wfile.write(body.encode("utf-8"))
        else:
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            data = {
                "id": "sb-mock-12345",
                "status": "running",
                "state": "running",
                "created": True,
                "success": True
            }
            self.wfile.write(json.dumps(data).encode("utf-8"))

socketserver.TCPServer(("", 5679), H).serve_forever()
