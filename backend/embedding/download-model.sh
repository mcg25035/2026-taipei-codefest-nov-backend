#!/bin/sh
# 下載 multilingual-e5-large 的量化 ONNX 模型（約 560 MB，不進版控）。
set -e
cd "$(dirname "$0")"
mkdir -p model
BASE=https://huggingface.co/Xenova/multilingual-e5-large/resolve/main
curl -fL -o model/model.onnx "$BASE/onnx/model_quantized.onnx"
curl -fL -o model/tokenizer.json "$BASE/tokenizer.json"
