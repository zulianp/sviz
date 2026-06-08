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
./build/sviz_server 8080 8081
```

Open `http://127.0.0.1:8080`. The server serves the browser client,
and the generated WASM artifacts from `build-wasm/`. Mesh generation happens in
the browser through `smesh::Mesh` compiled to WebAssembly.

The first port is HTTP. The second port is the monitor ingest socket. If the
second port is omitted, the server uses `http_port + 1`.

## Monitor Protocol

External tools can send the latest monitor mesh to the server through the
monitor ingest TCP socket. The browser Monitor view polls the server and renders
the latest accepted snapshot.

Each socket message is:

```text
<YAML header as UTF-8>
...
<binary payload>
```

The YAML document end marker, `...\n`, terminates the header. The header must
declare `binary_bytes`, and the sender must send exactly that many binary bytes
after the marker. Numeric payloads are little-endian.

Current monitor fields:

```yaml
sviz_protocol: 1
kind: monitor
name: quad-vector-example
endianness: little
binary_bytes: 1400
vector_scale: 0.35
points:
  dtype: float32
  components: 3
  count: 30
  offset: 0
quads:
  dtype: uint32
  components: 4
  count: 20
  offset: 360
vectors:
  dtype: float32
  components: 6
  count: 30
  offset: 680
...
```

Payload sections:

- `points`: `count * 3` float32 values, stored as `x, y, z`.
- `quads`: `count * 4` uint32 values, stored as node indices `a, b, c, d`.
- `vectors`: optional `count * 6` float32 values, stored as positioned vectors
  `x, y, z, vx, vy, vz`.

Send the included quadrilateral/vector example:

```sh
./scripts/send_monitor_example.py 127.0.0.1 8081
```

Then open the Monitor view in the browser. The server exposes the latest
snapshot to the web client at `/monitor.bin`.
