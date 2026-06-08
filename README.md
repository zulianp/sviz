# sviz
Simple Mesh Visualizer/Manipulator for SFEM

## Tool Environment

Install the repo-local toolchain:

```sh
./scripts/setup_tools.sh
```

Activate it in the current shell:

```sh
. scripts/env.sh
```

Build the native server and WebAssembly module:

```sh
./scripts/build_all.sh
```

Run the server:

```sh
./build/sviz_server 8080
```

Open `http://127.0.0.1:8080`. The server serves the browser client,
and the generated WASM artifacts from `build-wasm/`. Mesh generation happens in
the browser through `smesh::Mesh` compiled to WebAssembly.
