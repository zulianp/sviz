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

Open `http://127.0.0.1:8080` for the cube generator, or
`http://127.0.0.1:8080/monitor` for the monitor app. The server serves the
browser clients and the generated WASM artifacts from `build-wasm/`. Mesh
generation happens in the browser through `smesh::Mesh` compiled to WebAssembly.

The first port is HTTP. The second port is the monitor ingest socket. If the
second port is omitted, the server uses `http_port + 1`.

## Monitor Protocol

External tools can send the latest monitor mesh to the server through the
monitor ingest TCP socket. The browser Monitor view polls the server and renders
the latest accepted snapshot.

Each socket message is:

```text
<single-line JSON header as UTF-8>
<binary payload>
```

The newline after the JSON document terminates the header. The header must
declare `binary_bytes`, and the sender must send exactly that many binary bytes
after the newline. Numeric payloads are little-endian.

Current monitor fields:

```json
{"sviz_protocol":1,"kind":"monitor","name":"quad-vector-example","endianness":"little","binary_bytes":1400,"vector_scale":0.35,"points":{"dtype":"float32","components":3,"count":30,"offset":0},"quads":{"dtype":"uint32","components":4,"count":20,"offset":360},"vectors":{"dtype":"float32","components":6,"count":30,"offset":680}}
```

Payload sections:

- `points`: `count * 3` float32 values, stored as `x, y, z`.
- `quads`: `count * 4` uint32 values, stored as node indices `a, b, c, d`.
- `vectors`: optional `count * 6` float32 values, stored as positioned vectors
  `x, y, z, vx, vy, vz`.

## Monitor C++ Client

Other C++ applications can send monitor snapshots with the self-contained
header-only client in `src/sviz_monitor_client.hpp`. It has no dependencies
beyond the C++ standard library and system sockets. On Windows, link the
application with `Ws2_32`.

Send a quad mesh from SoA streams:

```cpp
#include "sviz_monitor_client.hpp"

float x[num_points], y[num_points], z[num_points];
uint32_t a[num_quads], b[num_quads], c[num_quads], d[num_quads];

sviz::Message msg("my-mesh");
msg.quad_mesh_soa(
    sviz::view(x, num_points),
    sviz::view(y, num_points),
    sviz::view(z, num_points),
    sviz::view(a, num_quads),
    sviz::view(b, num_quads),
    sviz::view(c, num_quads),
    sviz::view(d, num_quads));

sviz::Client("127.0.0.1", 8081).send(msg);
```

Send quivers from SoA streams:

```cpp
sviz::Message msg("velocity");
msg.set_vector_scale(0.1)
   .quivers_soa(
       sviz::view(x, n),
       sviz::view(y, n),
       sviz::view(z, n),
       sviz::view(vx, n),
       sviz::view(vy, n),
       sviz::view(vz, n));

sviz::Client().send(msg);
```

`view(data, count, stride)` also supports strided SoA fields. Interleaved
helpers are available as `points_interleaved`, `quads_interleaved`,
`quad_mesh_interleaved`, and `quivers_interleaved`.

Send a single quad:

```cpp
std::array<std::array<float, 3>, 4> quad = {{
    {{0, 0, 0}}, {{1, 0, 0}}, {{1, 1, 0}}, {{0, 1, 0}}}};

sviz::send_single_quad("127.0.0.1", 8081, "one-quad", quad);
```

Send the included quadrilateral/vector example:

```sh
./scripts/send_monitor_example.py 127.0.0.1 8081
```

With the default server ports, the same command can be shortened to:

```sh
./scripts/send_monitor_example.py
```

Then open `http://127.0.0.1:8080/monitor` in the browser. The server exposes the
latest snapshot to the web client at `/monitor.bin`.
