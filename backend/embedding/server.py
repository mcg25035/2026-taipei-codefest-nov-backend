"""文字向量服務。只聽 127.0.0.1，由後端呼叫；沒有驗證，不可對外開放。

POST /embed {"text": "..."} -> {"vector": [...], "model": "..."}
GET  /healthz               -> {"status": "ok"}
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_NAME = "multilingual-e5-large-q8"
MODEL_DIR = Path(__file__).parent / "model"
MAX_TOKENS = 512
MAX_BODY_BYTES = 64 * 1024

options = ort.SessionOptions()
options.intra_op_num_threads = int(os.environ.get("EMBEDDING_THREADS", "2"))
options.inter_op_num_threads = 1
session = ort.InferenceSession(str(MODEL_DIR / "model.onnx"), options, providers=["CPUExecutionProvider"])
tokenizer = Tokenizer.from_file(str(MODEL_DIR / "tokenizer.json"))


def embed(text):
    # e5 要求文字前加上用途前綴；問題互相比對時，兩邊都用 query。
    ids = tokenizer.encode("query: " + text).ids[:MAX_TOKENS]
    feed = {
        "input_ids": np.array([ids], dtype=np.int64),
        "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
    }
    # 這個模型用所有 token 的平均當整句的向量。
    vector = session.run(None, feed)[0][0].mean(axis=0)
    return (vector / np.linalg.norm(vector)).tolist()


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self.respond(200, {"status": "ok", "model": MODEL_NAME})
        else:
            self.respond(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if self.path != "/embed" or length > MAX_BODY_BYTES:
            self.respond(404 if self.path != "/embed" else 413, {"error": "bad request"})
            return
        try:
            text = json.loads(self.rfile.read(length))["text"]
            if not isinstance(text, str) or not text.strip():
                raise ValueError
        except (ValueError, KeyError, TypeError):
            self.respond(400, {"error": "text is required"})
            return
        self.respond(200, {"vector": embed(text), "model": MODEL_NAME})

    # 不記錄請求，避免問題內容留在紀錄裡。
    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("EMBEDDING_PORT", "5122"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
