The browser depth guide uses [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small) (Apache 2.0), bundled with Transformers.js 3.8.1 (Apache 2.0) and ONNX Runtime Web (MIT). These files run locally in the browser; the app does not fetch a model at runtime.

Run `bun install` and `node scripts/update-depth-vendor.mjs` to rebuild the bundle and model files. The script pins the model revision and checks the ONNX file's SHA-256 hash.
