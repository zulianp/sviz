#ifndef SVIZ_MONITOR_CLIENT_HPP
#define SVIZ_MONITOR_CLIENT_HPP

#include <array>
#include <cstdint>
#include <cstring>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace sviz {

class Error : public std::runtime_error {
public:
  explicit Error(const std::string &message) : std::runtime_error(message) {}
};

template <class T> struct ArrayView {
  const T *data{nullptr};
  std::size_t count{0};
  std::size_t stride{1};

  ArrayView() = default;
  ArrayView(const T *data_in, std::size_t count_in,
            std::size_t stride_in = 1)
      : data(data_in), count(count_in), stride(stride_in) {}

  const T &operator[](std::size_t i) const { return data[i * stride]; }
};

template <class T>
inline ArrayView<T> view(const T *data, std::size_t count,
                         std::size_t stride = 1) {
  return ArrayView<T>(data, count, stride);
}

namespace detail {

inline bool is_little_endian() {
  const std::uint16_t value = 1;
  return *reinterpret_cast<const unsigned char *>(&value) == 1;
}

inline void append_bytes(std::vector<char> &out, const void *data,
                         std::size_t bytes) {
  const char *begin = static_cast<const char *>(data);
  out.insert(out.end(), begin, begin + bytes);
}

inline void append_u32_le(std::vector<char> &out, std::uint32_t value) {
  if (is_little_endian()) {
    append_bytes(out, &value, sizeof(value));
    return;
  }

  out.push_back(static_cast<char>(value & 0xffu));
  out.push_back(static_cast<char>((value >> 8u) & 0xffu));
  out.push_back(static_cast<char>((value >> 16u) & 0xffu));
  out.push_back(static_cast<char>((value >> 24u) & 0xffu));
}

inline void append_f32_le(std::vector<char> &out, float value) {
  std::uint32_t bits = 0;
  static_assert(sizeof(bits) == sizeof(value), "float32 packing mismatch");
  std::memcpy(&bits, &value, sizeof(bits));
  append_u32_le(out, bits);
}

template <class T> inline void append_scalar_as_f32(std::vector<char> &out, T v) {
  append_f32_le(out, static_cast<float>(v));
}

template <class T>
inline void append_scalar_as_u32(std::vector<char> &out, T v) {
  if (v < 0 ||
      static_cast<unsigned long long>(v) >
          static_cast<unsigned long long>(std::numeric_limits<std::uint32_t>::max())) {
    throw Error("quad index does not fit in uint32");
  }
  append_u32_le(out, static_cast<std::uint32_t>(v));
}

inline std::string json_escape(const std::string &value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (const char c : value) {
    switch (c) {
    case '"':
      out += "\\\"";
      break;
    case '\\':
      out += "\\\\";
      break;
    case '\b':
      out += "\\b";
      break;
    case '\f':
      out += "\\f";
      break;
    case '\n':
      out += "\\n";
      break;
    case '\r':
      out += "\\r";
      break;
    case '\t':
      out += "\\t";
      break;
    default:
      if (static_cast<unsigned char>(c) < 0x20) {
        const char *digits = "0123456789abcdef";
        out += "\\u00";
        out.push_back(digits[(static_cast<unsigned char>(c) >> 4) & 0xf]);
        out.push_back(digits[static_cast<unsigned char>(c) & 0xf]);
      } else {
        out.push_back(c);
      }
    }
  }
  return out;
}

inline void check_view(const char *name, std::size_t expected_count,
                       std::size_t count, const void *data,
                       std::size_t stride) {
  if (count != expected_count) {
    throw Error(std::string(name) + " stream has inconsistent length");
  }
  if (count > 0 && data == nullptr) {
    throw Error(std::string(name) + " stream has null data");
  }
  if (stride == 0) {
    throw Error(std::string(name) + " stream has zero stride");
  }
}

inline std::string service_from_port(int port) {
  if (port <= 0 || port > 65535) {
    throw Error("port must be in [1, 65535]");
  }
  return std::to_string(port);
}

#if defined(_WIN32)
using socket_type = SOCKET;
const socket_type invalid_socket = INVALID_SOCKET;

inline void close_socket(socket_type fd) { closesocket(fd); }

class WsaSession {
public:
  WsaSession() {
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
      throw Error("WSAStartup failed");
    }
  }
  ~WsaSession() { WSACleanup(); }
};
#else
using socket_type = int;
const socket_type invalid_socket = -1;

inline void close_socket(socket_type fd) { ::close(fd); }
#endif

inline socket_type connect_tcp(const std::string &host, int port) {
#if defined(_WIN32)
  static WsaSession wsa;
#endif

  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;

  addrinfo *result = nullptr;
  const std::string service = service_from_port(port);
  const int rc = getaddrinfo(host.c_str(), service.c_str(), &hints, &result);
  if (rc != 0) {
    throw Error(std::string("getaddrinfo failed for ") + host + ":" + service);
  }

  socket_type fd = invalid_socket;
  for (addrinfo *it = result; it != nullptr; it = it->ai_next) {
    fd = ::socket(it->ai_family, it->ai_socktype, it->ai_protocol);
    if (fd == invalid_socket) {
      continue;
    }
    if (::connect(fd, it->ai_addr, static_cast<int>(it->ai_addrlen)) == 0) {
      break;
    }
    close_socket(fd);
    fd = invalid_socket;
  }

  freeaddrinfo(result);
  if (fd == invalid_socket) {
    throw Error(std::string("failed to connect to ") + host + ":" + service);
  }
  return fd;
}

inline void send_all(socket_type fd, const char *data, std::size_t bytes) {
  while (bytes > 0) {
#if defined(_WIN32)
    const int chunk =
        bytes > static_cast<std::size_t>(std::numeric_limits<int>::max())
            ? std::numeric_limits<int>::max()
            : static_cast<int>(bytes);
    const int sent = ::send(fd, data, chunk, 0);
#else
    const ssize_t sent = ::send(fd, data, bytes, 0);
#endif
    if (sent <= 0) {
      throw Error("socket send failed");
    }
    data += sent;
    bytes -= static_cast<std::size_t>(sent);
  }
}

struct Section {
  const char *name{nullptr};
  const char *dtype{nullptr};
  std::uint32_t components{0};
  std::size_t count{0};
  std::size_t offset{0};
  bool present{false};
};

} // namespace detail

class Message {
public:
  explicit Message(std::string name = "sviz-monitor")
      : name_(std::move(name)) {}

  Message &set_vector_scale(double scale) {
    vector_scale_ = scale;
    return *this;
  }

  template <class X, class Y, class Z>
  Message &points_soa(ArrayView<X> x, ArrayView<Y> y, ArrayView<Z> z) {
    detail::check_view("point x", x.count, x.count, x.data, x.stride);
    detail::check_view("point y", x.count, y.count, y.data, y.stride);
    detail::check_view("point z", x.count, z.count, z.data, z.stride);
    require_section_absent(points_, "points");

    points_ = add_section("points", "float32", 3, x.count);
    for (std::size_t i = 0; i < x.count; ++i) {
      detail::append_scalar_as_f32(payload_, x[i]);
      detail::append_scalar_as_f32(payload_, y[i]);
      detail::append_scalar_as_f32(payload_, z[i]);
    }
    return *this;
  }

  template <class T>
  Message &points_interleaved(const T *xyz, std::size_t point_count,
                              std::size_t stride_components = 3) {
    if (point_count > 0 && xyz == nullptr) {
      throw Error("interleaved point stream has null data");
    }
    if (stride_components < 3) {
      throw Error("interleaved point stride must be at least 3 components");
    }
    return points_soa(view(xyz, point_count, stride_components),
                      view(xyz + 1, point_count, stride_components),
                      view(xyz + 2, point_count, stride_components));
  }

  template <class A, class B, class C, class D>
  Message &quads_soa(ArrayView<A> a, ArrayView<B> b, ArrayView<C> c,
                     ArrayView<D> d) {
    detail::check_view("quad a", a.count, a.count, a.data, a.stride);
    detail::check_view("quad b", a.count, b.count, b.data, b.stride);
    detail::check_view("quad c", a.count, c.count, c.data, c.stride);
    detail::check_view("quad d", a.count, d.count, d.data, d.stride);
    require_section_absent(quads_, "quads");

    quads_ = add_section("quads", "uint32", 4, a.count);
    for (std::size_t i = 0; i < a.count; ++i) {
      detail::append_scalar_as_u32(payload_, a[i]);
      detail::append_scalar_as_u32(payload_, b[i]);
      detail::append_scalar_as_u32(payload_, c[i]);
      detail::append_scalar_as_u32(payload_, d[i]);
    }
    return *this;
  }

  template <class I>
  Message &quads_interleaved(const I *abcd, std::size_t quad_count,
                             std::size_t stride_components = 4) {
    if (quad_count > 0 && abcd == nullptr) {
      throw Error("interleaved quad stream has null data");
    }
    if (stride_components < 4) {
      throw Error("interleaved quad stride must be at least 4 components");
    }
    return quads_soa(view(abcd, quad_count, stride_components),
                     view(abcd + 1, quad_count, stride_components),
                     view(abcd + 2, quad_count, stride_components),
                     view(abcd + 3, quad_count, stride_components));
  }

  template <class X, class Y, class Z, class A, class B, class C, class D>
  Message &quad_mesh_soa(ArrayView<X> x, ArrayView<Y> y, ArrayView<Z> z,
                         ArrayView<A> a, ArrayView<B> b, ArrayView<C> c,
                         ArrayView<D> d) {
    points_soa(x, y, z);
    quads_soa(a, b, c, d);
    return *this;
  }

  template <class T, class I>
  Message &quad_mesh_interleaved(const T *xyz, std::size_t point_count,
                                 const I *abcd, std::size_t quad_count,
                                 std::size_t point_stride_components = 3,
                                 std::size_t quad_stride_components = 4) {
    points_interleaved(xyz, point_count, point_stride_components);
    quads_interleaved(abcd, quad_count, quad_stride_components);
    return *this;
  }

  template <class T>
  Message &single_quad(const std::array<std::array<T, 3>, 4> &vertices) {
    const T x[4] = {vertices[0][0], vertices[1][0], vertices[2][0],
                    vertices[3][0]};
    const T y[4] = {vertices[0][1], vertices[1][1], vertices[2][1],
                    vertices[3][1]};
    const T z[4] = {vertices[0][2], vertices[1][2], vertices[2][2],
                    vertices[3][2]};
    const std::uint32_t q[4] = {0, 1, 2, 3};
    return quad_mesh_soa(view(x, 4), view(y, 4), view(z, 4), view(q, 1, 4),
                         view(q + 1, 1, 4), view(q + 2, 1, 4),
                         view(q + 3, 1, 4));
  }

  template <class X, class Y, class Z, class VX, class VY, class VZ>
  Message &quivers_soa(ArrayView<X> x, ArrayView<Y> y, ArrayView<Z> z,
                       ArrayView<VX> vx, ArrayView<VY> vy, ArrayView<VZ> vz) {
    detail::check_view("quiver x", x.count, x.count, x.data, x.stride);
    detail::check_view("quiver y", x.count, y.count, y.data, y.stride);
    detail::check_view("quiver z", x.count, z.count, z.data, z.stride);
    detail::check_view("quiver vx", x.count, vx.count, vx.data, vx.stride);
    detail::check_view("quiver vy", x.count, vy.count, vy.data, vy.stride);
    detail::check_view("quiver vz", x.count, vz.count, vz.data, vz.stride);

    if (!points_.present) {
      points_soa(x, y, z);
    }
    if (!quads_.present) {
      quads_ = add_section("quads", "uint32", 4, 0);
    }
    require_section_absent(vectors_, "vectors");

    vectors_ = add_section("vectors", "float32", 6, x.count);
    for (std::size_t i = 0; i < x.count; ++i) {
      detail::append_scalar_as_f32(payload_, x[i]);
      detail::append_scalar_as_f32(payload_, y[i]);
      detail::append_scalar_as_f32(payload_, z[i]);
      detail::append_scalar_as_f32(payload_, vx[i]);
      detail::append_scalar_as_f32(payload_, vy[i]);
      detail::append_scalar_as_f32(payload_, vz[i]);
    }
    return *this;
  }

  template <class T>
  Message &quivers_interleaved(const T *xyz_vxyz, std::size_t vector_count,
                               std::size_t stride_components = 6) {
    if (vector_count > 0 && xyz_vxyz == nullptr) {
      throw Error("interleaved quiver stream has null data");
    }
    if (stride_components < 6) {
      throw Error("interleaved quiver stride must be at least 6 components");
    }
    return quivers_soa(view(xyz_vxyz, vector_count, stride_components),
                       view(xyz_vxyz + 1, vector_count, stride_components),
                       view(xyz_vxyz + 2, vector_count, stride_components),
                       view(xyz_vxyz + 3, vector_count, stride_components),
                       view(xyz_vxyz + 4, vector_count, stride_components),
                       view(xyz_vxyz + 5, vector_count, stride_components));
  }

  std::string header_json() const {
    if (!points_.present) {
      throw Error("monitor message is missing points");
    }
    if (!quads_.present) {
      throw Error("monitor message is missing quads");
    }

    std::ostringstream out;
    out << "{\"sviz_protocol\":1"
        << ",\"kind\":\"monitor\""
        << ",\"name\":\"" << detail::json_escape(name_) << "\""
        << ",\"endianness\":\"little\""
        << ",\"binary_bytes\":" << payload_.size()
        << ",\"vector_scale\":" << vector_scale_;
    append_section_json(out, points_);
    append_section_json(out, quads_);
    if (vectors_.present) {
      append_section_json(out, vectors_);
    }
    out << "}";
    return out.str();
  }

  std::vector<char> wire_bytes() const {
    std::string header = header_json();
    header.push_back('\n');
    std::vector<char> bytes;
    bytes.reserve(header.size() + payload_.size());
    bytes.insert(bytes.end(), header.begin(), header.end());
    bytes.insert(bytes.end(), payload_.begin(), payload_.end());
    return bytes;
  }

  const std::vector<char> &payload() const { return payload_; }

private:
  detail::Section add_section(const char *name, const char *dtype,
                              std::uint32_t components, std::size_t count) {
    detail::Section section;
    section.name = name;
    section.dtype = dtype;
    section.components = components;
    section.count = count;
    section.offset = payload_.size();
    section.present = true;
    return section;
  }

  static void require_section_absent(const detail::Section &section,
                                     const char *name) {
    if (section.present) {
      throw Error(std::string(name) + " section is already present");
    }
  }

  static void append_section_json(std::ostringstream &out,
                                  const detail::Section &section) {
    out << ",\"" << section.name << "\":{"
        << "\"dtype\":\"" << section.dtype << "\""
        << ",\"components\":" << section.components
        << ",\"count\":" << section.count
        << ",\"offset\":" << section.offset << "}";
  }

  std::string name_;
  double vector_scale_{1.0};
  std::vector<char> payload_;
  detail::Section points_;
  detail::Section quads_;
  detail::Section vectors_;
};

class Client {
public:
  explicit Client(std::string host = "127.0.0.1", int port = 8081)
      : host_(std::move(host)), port_(port) {}

  void send(const Message &message) const {
    const std::vector<char> bytes = message.wire_bytes();
    detail::socket_type fd = detail::connect_tcp(host_, port_);
    try {
      detail::send_all(fd, bytes.data(), bytes.size());
      detail::close_socket(fd);
    } catch (...) {
      detail::close_socket(fd);
      throw;
    }
  }

private:
  std::string host_;
  int port_;
};

template <class X, class Y, class Z, class A, class B, class C, class D>
inline void send_quad_mesh_soa(const std::string &host, int port,
                               const std::string &name, ArrayView<X> x,
                               ArrayView<Y> y, ArrayView<Z> z, ArrayView<A> a,
                               ArrayView<B> b, ArrayView<C> c,
                               ArrayView<D> d) {
  Message message(name);
  message.quad_mesh_soa(x, y, z, a, b, c, d);
  Client(host, port).send(message);
}

template <class T>
inline void send_single_quad(const std::string &host, int port,
                             const std::string &name,
                             const std::array<std::array<T, 3>, 4> &vertices) {
  Message message(name);
  message.single_quad(vertices);
  Client(host, port).send(message);
}

template <class X, class Y, class Z, class VX, class VY, class VZ>
inline void send_quivers_soa(const std::string &host, int port,
                             const std::string &name, ArrayView<X> x,
                             ArrayView<Y> y, ArrayView<Z> z, ArrayView<VX> vx,
                             ArrayView<VY> vy, ArrayView<VZ> vz,
                             double vector_scale = 1.0) {
  Message message(name);
  message.set_vector_scale(vector_scale).quivers_soa(x, y, z, vx, vy, vz);
  Client(host, port).send(message);
}

} // namespace sviz

#endif // SVIZ_MONITOR_CLIENT_HPP
