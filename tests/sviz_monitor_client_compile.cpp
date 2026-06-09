#include "sviz_monitor_client.hpp"

#include <array>
#include <cstdlib>
#include <cstdint>

int main(int argc, char **argv) {
  float x[4] = {0.0f, 1.0f, 1.0f, 0.0f};
  float y[4] = {0.0f, 0.0f, 1.0f, 1.0f};
  float z[4] = {0.0f, 0.0f, 0.0f, 0.0f};
  std::uint32_t q[4] = {0, 1, 2, 3};

  sviz::Message mesh("compile-mesh");
  mesh.quad_mesh_soa(sviz::view(x, 4), sviz::view(y, 4),
                     sviz::view(z, 4), sviz::view(q, 1, 4),
                     sviz::view(q + 1, 1, 4),
                     sviz::view(q + 2, 1, 4),
                     sviz::view(q + 3, 1, 4));
  (void)mesh.wire_bytes();

  std::array<std::array<float, 3>, 4> quad = {
      {{{0.0f, 0.0f, 0.0f}},
       {{1.0f, 0.0f, 0.0f}},
       {{1.0f, 1.0f, 0.0f}},
       {{0.0f, 1.0f, 0.0f}}}};
  sviz::Message single("compile-single-quad");
  single.single_quad(quad);
  (void)single.header_json();

  float vx[4] = {1.0f, 0.0f, -1.0f, 0.0f};
  float vy[4] = {0.0f, 1.0f, 0.0f, -1.0f};
  float vz[4] = {0.0f, 0.0f, 0.0f, 0.0f};
  sviz::Message quivers("compile-quivers");
  quivers.set_vector_scale(0.25)
      .quivers_soa(sviz::view(x, 4), sviz::view(y, 4),
                   sviz::view(z, 4), sviz::view(vx, 4),
                   sviz::view(vy, 4), sviz::view(vz, 4));
  (void)quivers.wire_bytes();

  if (argc == 3) {
    sviz::Client client(argv[1], std::atoi(argv[2]));
    client.send(mesh);
    client.send(single);
    client.send(quivers);
  }

  return 0;
}
