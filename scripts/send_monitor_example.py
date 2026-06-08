#!/usr/bin/env python3
import math
import socket
import struct
import sys


def pack_f32(values):
    return struct.pack("<" + "f" * len(values), *values)


def pack_u32(values):
    return struct.pack("<" + "I" * len(values), *values)


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8082

    nx = 5
    ny = 4
    points = []
    vectors = []
    for j in range(ny + 1):
        y = j / ny - 0.5
        for i in range(nx + 1):
            x = i / nx - 0.5
            z = 0.16 * math.sin(math.pi * x * 2.0) * math.cos(math.pi * y * 2.0)
            points.extend([x, y, z])
            vectors.extend([x, y, z, -y, x, 0.25])

    quads = []
    for j in range(ny):
        for i in range(nx):
            a = j * (nx + 1) + i
            quads.extend([a, a + 1, a + nx + 2, a + nx + 1])

    point_bytes = pack_f32(points)
    quad_bytes = pack_u32(quads)
    vector_bytes = pack_f32(vectors)
    quad_offset = len(point_bytes)
    vector_offset = quad_offset + len(quad_bytes)
    payload = point_bytes + quad_bytes + vector_bytes

    header = f"""sviz_protocol: 1
kind: monitor
name: quad-vector-example
endianness: little
binary_bytes: {len(payload)}
vector_scale: 0.35
points:
  dtype: float32
  components: 3
  count: {len(points) // 3}
  offset: 0
quads:
  dtype: uint32
  components: 4
  count: {len(quads) // 4}
  offset: {quad_offset}
vectors:
  dtype: float32
  components: 6
  count: {len(vectors) // 6}
  offset: {vector_offset}
...
""".encode("utf-8")

    with socket.create_connection((host, port), timeout=5.0) as sock:
        sock.sendall(header)
        sock.sendall(payload)

    print(
        f"sent {len(points) // 3} points, {len(quads) // 4} quads, "
        f"{len(vectors) // 6} vectors to {host}:{port}"
    )


if __name__ == "__main__":
    main()
