#!/bin/sh
# 下載 gte-multilingual-base 的量化 ONNX 模型（約 340 MB，不進版控）。
set -e
cd "$(dirname "$0")"
mkdir -p model
BASE=https://huggingface.co/onnx-community/gte-multilingual-base/resolve/main
curl -fL -o model/model.onnx "$BASE/onnx/model_quantized.onnx"
curl -fL -o model/tokenizer.json "$BASE/tokenizer.json"
