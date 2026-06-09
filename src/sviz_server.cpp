#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

struct Request {
  std::string method;
  std::string path;
  std::string query;
};

struct MonitorSnapshot {
  std::uint64_t id{0};
  std::uint64_t sequence{0};
  std::uint64_t binary_bytes{0};
  std::string name;
  std::string header;
  std::vector<char> payload;
};

std::vector<std::filesystem::path> g_asset_roots;
std::mutex g_monitor_mutex;
std::vector<MonitorSnapshot> g_monitor_snapshots;
std::uint64_t g_monitor_version = 0;
std::uint64_t g_monitor_next_id = 1;
int g_monitor_port = 0;

std::string read_file(const std::filesystem::path &path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    return "";
  }
  return std::string(std::istreambuf_iterator<char>(in),
                     std::istreambuf_iterator<char>());
}

std::filesystem::path executable_dir(const char *argv0) {
  std::filesystem::path exe(argv0);
  if (exe.is_relative()) {
    exe = std::filesystem::current_path() / exe;
  }
  return std::filesystem::weakly_canonical(exe).parent_path();
}

void init_asset_roots(const char *argv0) {
  const auto cwd = std::filesystem::current_path();
  const auto exe_dir = executable_dir(argv0);

  g_asset_roots = {
      cwd,
      exe_dir,
      exe_dir.parent_path(),
  };
}

std::filesystem::path find_asset(const std::string &relative_path) {
  for (const auto &root : g_asset_roots) {
    const auto candidate = root / relative_path;
    if (std::filesystem::exists(candidate)) {
      return candidate;
    }
  }
  return {};
}

std::string missing_asset_message(const std::string &relative_path) {
  std::ostringstream out;
  out << "file not found: " << relative_path << "\nsearched:\n";
  for (const auto &root : g_asset_roots) {
    out << "  " << (root / relative_path).string() << "\n";
  }
  return out.str();
}

void send_all(int fd, const std::string &data) {
  const char *ptr = data.data();
  std::size_t left = data.size();
  while (left > 0) {
    const ssize_t n = ::send(fd, ptr, left, 0);
    if (n <= 0) {
      return;
    }
    ptr += n;
    left -= static_cast<std::size_t>(n);
  }
}

void respond(int fd, int status, const std::string &status_text,
             const std::string &content_type, const std::string &body) {
  std::ostringstream out;
  out << "HTTP/1.1 " << status << ' ' << status_text << "\r\n"
      << "Content-Type: " << content_type << "\r\n"
      << "Cache-Control: no-store\r\n"
      << "Content-Length: " << body.size() << "\r\n"
      << "Connection: close\r\n\r\n"
      << body;
  send_all(fd, out.str());
}

void respond_empty(int fd, int status, const std::string &status_text) {
  std::ostringstream out;
  out << "HTTP/1.1 " << status << ' ' << status_text << "\r\n"
      << "Cache-Control: no-store\r\n"
      << "Content-Length: 0\r\n"
      << "Connection: close\r\n\r\n";
  send_all(fd, out.str());
}

Request read_request(int fd) {
  std::string raw;
  char buffer[2048];
  while (raw.find("\r\n\r\n") == std::string::npos) {
    const ssize_t n = ::recv(fd, buffer, sizeof(buffer), 0);
    if (n <= 0) {
      throw std::runtime_error("client closed connection");
    }
    raw.append(buffer, static_cast<std::size_t>(n));
    if (raw.size() > 64 * 1024) {
      throw std::runtime_error("request headers too large");
    }
  }

  std::istringstream line(raw);
  Request req;
  line >> req.method >> req.path;
  const auto query = req.path.find('?');
  if (query != std::string::npos) {
    req.query = req.path.substr(query + 1);
    req.path.resize(query);
  }
  return req;
}

std::string content_type(const std::string &path) {
  if (path.size() >= 5 && path.substr(path.size() - 5) == ".html") {
    return "text/html; charset=utf-8";
  }
  if (path.size() >= 3 && path.substr(path.size() - 3) == ".js") {
    return "application/javascript; charset=utf-8";
  }
  if (path.size() >= 5 && path.substr(path.size() - 5) == ".wasm") {
    return "application/wasm";
  }
  if (path.size() >= 4 && path.substr(path.size() - 4) == ".css") {
    return "text/css; charset=utf-8";
  }
  return "application/octet-stream";
}

std::string route_to_file(const std::string &path) {
  if (path == "/") {
    return "web/index.html";
  }
  if (path == "/monitor" || path == "/monitor/") {
    return "web/monitor.html";
  }
  if (path == "/monitor.html") {
    return "web/monitor.html";
  }
  if (path == "/app.js") {
    return "web/app.js";
  }
  if (path == "/monitor.js") {
    return "web/monitor.js";
  }
  if (path == "/viewer.js") {
    return "web/viewer.js";
  }
  if (path == "/wasm/sviz_wasm.js") {
    return "build-wasm/sviz_wasm.js";
  }
  if (path == "/wasm/sviz_wasm.wasm") {
    return "build-wasm/sviz_wasm.wasm";
  }
  return "";
}

std::size_t json_header_end(const std::vector<char> &buffer) {
  const auto it = std::find(buffer.begin(), buffer.end(), '\n');
  if (it == buffer.end()) {
    return std::string::npos;
  }
  return static_cast<std::size_t>(std::distance(buffer.begin(), it)) + 1;
}

std::uint64_t parse_binary_bytes(const std::string &header) {
  const auto key = header.find("\"binary_bytes\"");
  if (key == std::string::npos) {
    throw std::runtime_error("monitor JSON header missing binary_bytes");
  }
  const auto colon = header.find(':', key);
  if (colon == std::string::npos) {
    throw std::runtime_error("monitor JSON header has invalid binary_bytes");
  }
  std::size_t first_digit = colon + 1;
  while (first_digit < header.size() &&
         (header[first_digit] == ' ' || header[first_digit] == '\t')) {
    ++first_digit;
  }
  if (first_digit == header.size() ||
      !std::isdigit(static_cast<unsigned char>(header[first_digit]))) {
    throw std::runtime_error("monitor JSON header has invalid binary_bytes");
  }
  std::size_t end = first_digit;
  while (end < header.size() &&
         std::isdigit(static_cast<unsigned char>(header[end]))) {
    ++end;
  }
  return std::stoull(header.substr(first_digit, end - first_digit));
}

std::uint64_t parse_json_u64(const std::string &header,
                             const std::string &field,
                             const std::uint64_t fallback = 0) {
  const std::string key = "\"" + field + "\"";
  const auto key_pos = header.find(key);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  const auto colon = header.find(':', key_pos);
  if (colon == std::string::npos) {
    return fallback;
  }
  std::size_t first_digit = colon + 1;
  while (first_digit < header.size() &&
         std::isspace(static_cast<unsigned char>(header[first_digit]))) {
    ++first_digit;
  }
  if (first_digit == header.size() ||
      !std::isdigit(static_cast<unsigned char>(header[first_digit]))) {
    return fallback;
  }
  std::size_t end = first_digit;
  while (end < header.size() &&
         std::isdigit(static_cast<unsigned char>(header[end]))) {
    ++end;
  }
  return std::stoull(header.substr(first_digit, end - first_digit));
}

std::string parse_json_string(const std::string &header,
                              const std::string &field,
                              const std::string &fallback = "") {
  const std::string key = "\"" + field + "\"";
  const auto key_pos = header.find(key);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  const auto colon = header.find(':', key_pos);
  if (colon == std::string::npos) {
    return fallback;
  }
  std::size_t quote = colon + 1;
  while (quote < header.size() &&
         std::isspace(static_cast<unsigned char>(header[quote]))) {
    ++quote;
  }
  if (quote == header.size() || header[quote] != '"') {
    return fallback;
  }

  std::string out;
  for (std::size_t i = quote + 1; i < header.size(); ++i) {
    const char c = header[i];
    if (c == '"') {
      return out;
    }
    if (c == '\\' && i + 1 < header.size()) {
      const char escaped = header[++i];
      switch (escaped) {
      case '"':
      case '\\':
      case '/':
        out.push_back(escaped);
        break;
      case 'b':
        out.push_back('\b');
        break;
      case 'f':
        out.push_back('\f');
        break;
      case 'n':
        out.push_back('\n');
        break;
      case 'r':
        out.push_back('\r');
        break;
      case 't':
        out.push_back('\t');
        break;
      default:
        break;
      }
    } else {
      out.push_back(c);
    }
  }

  return fallback;
}

std::string json_escape(const std::string &value) {
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

std::uint64_t parse_query_u64(const std::string &query,
                              const std::string &key,
                              const std::uint64_t fallback = 0) {
  std::size_t pos = 0;
  while (pos <= query.size()) {
    const auto amp = query.find('&', pos);
    const auto end = amp == std::string::npos ? query.size() : amp;
    const auto eq = query.find('=', pos);
    if (eq != std::string::npos && eq < end &&
        query.substr(pos, eq - pos) == key) {
      const std::string value = query.substr(eq + 1, end - eq - 1);
      if (!value.empty() &&
          std::all_of(value.begin(), value.end(), [](unsigned char c) {
            return std::isdigit(c);
          })) {
        return std::stoull(value);
      }
      return fallback;
    }
    if (amp == std::string::npos) {
      break;
    }
    pos = amp + 1;
  }
  return fallback;
}

bool recv_more(int fd, std::vector<char> &buffer) {
  char chunk[8192];
  const ssize_t n = ::recv(fd, chunk, sizeof(chunk), 0);
  if (n <= 0) {
    return false;
  }
  buffer.insert(buffer.end(), chunk, chunk + n);
  return true;
}

void clear_monitor_snapshots() {
  std::lock_guard<std::mutex> lock(g_monitor_mutex);
  g_monitor_snapshots.clear();
  ++g_monitor_version;
}

void handle_monitor_ingest(int fd) {
  try {
    std::vector<char> buffer;
    std::size_t header_bytes = std::string::npos;
    while (header_bytes == std::string::npos) {
      if (!recv_more(fd, buffer)) {
        throw std::runtime_error(
            "monitor sender closed before JSON header end");
      }
      if (buffer.size() > 1024 * 1024) {
        throw std::runtime_error("monitor JSON header exceeds 1 MiB");
      }
      header_bytes = json_header_end(buffer);
    }

    const std::string header(buffer.data(), buffer.data() + header_bytes);
    const std::uint64_t payload_bytes = parse_binary_bytes(header);
    const std::string kind = parse_json_string(header, "kind", "monitor");
    if (payload_bytes > 1024ull * 1024ull * 1024ull) {
      throw std::runtime_error("monitor payload exceeds 1 GiB");
    }

    while (buffer.size() < header_bytes + payload_bytes) {
      if (!recv_more(fd, buffer)) {
        throw std::runtime_error(
            "monitor sender closed before binary payload end");
      }
    }

    if (kind == "clear") {
      clear_monitor_snapshots();
      std::cout << "Monitor snapshots cleared\n";
      ::close(fd);
      return;
    }

    if (kind != "monitor") {
      throw std::runtime_error("unsupported monitor message kind: " + kind);
    }

    MonitorSnapshot next;
    next.binary_bytes = payload_bytes;
    next.name = parse_json_string(header, "name", "monitor");
    next.header = header;
    next.payload.assign(
        buffer.begin() + static_cast<std::ptrdiff_t>(header_bytes),
        buffer.begin() +
            static_cast<std::ptrdiff_t>(header_bytes + payload_bytes));
    {
      std::lock_guard<std::mutex> lock(g_monitor_mutex);
      next.id = g_monitor_next_id++;
      next.sequence = next.id;
      g_monitor_snapshots.push_back(std::move(next));
      ++g_monitor_version;
    }
    std::cout << "Monitor snapshot received: " << payload_bytes << " bytes\n";
  } catch (const std::exception &e) {
    std::cerr << "monitor ingest: " << e.what() << "\n";
  }
  ::close(fd);
}

void respond_monitor_snapshot(int fd, const Request &req) {
  MonitorSnapshot snapshot;
  {
    std::lock_guard<std::mutex> lock(g_monitor_mutex);
    if (g_monitor_snapshots.empty()) {
      respond_empty(fd, 204, "No Content");
      return;
    }

    const std::uint64_t requested_id = parse_query_u64(req.query, "id");
    if (requested_id == 0) {
      snapshot = g_monitor_snapshots.back();
    } else {
      const auto it = std::find_if(
          g_monitor_snapshots.begin(), g_monitor_snapshots.end(),
          [requested_id](const MonitorSnapshot &candidate) {
            return candidate.id == requested_id;
          });
      if (it == g_monitor_snapshots.end()) {
        respond_empty(fd, 404, "Not Found");
        return;
      }
      snapshot = *it;
    }
  }

  std::string body;
  body.reserve(snapshot.header.size() + snapshot.payload.size());
  body.append(snapshot.header);
  body.append(snapshot.payload.data(), snapshot.payload.size());
  respond(fd, 200, "OK", "application/octet-stream", body);
}

void respond_monitor_info(int fd) {
  std::uint64_t version = 0;
  std::size_t count = 0;
  {
    std::lock_guard<std::mutex> lock(g_monitor_mutex);
    version = g_monitor_version;
    count = g_monitor_snapshots.size();
  }

  std::ostringstream body;
  body << "{"
       << "\"version\":" << version << ","
       << "\"count\":" << count << ","
       << "\"ingest_host\":\"127.0.0.1\","
       << "\"ingest_port\":" << g_monitor_port << "}\n";
  respond(fd, 200, "OK", "application/json; charset=utf-8", body.str());
}

void respond_monitor_list(int fd) {
  std::vector<MonitorSnapshot> snapshots;
  std::uint64_t version = 0;
  {
    std::lock_guard<std::mutex> lock(g_monitor_mutex);
    snapshots = g_monitor_snapshots;
    version = g_monitor_version;
  }

  std::ostringstream body;
  body << "{\"version\":" << version << ",\"messages\":[";
  for (std::size_t i = 0; i < snapshots.size(); ++i) {
    const auto &snapshot = snapshots[i];
    if (i > 0) {
      body << ",";
    }
    body << "{"
         << "\"id\":" << snapshot.id << ","
         << "\"sequence\":" << snapshot.sequence << ","
         << "\"name\":\"" << json_escape(snapshot.name) << "\","
         << "\"binary_bytes\":" << snapshot.binary_bytes << ","
         << "\"points\":" << parse_json_u64(snapshot.header, "count", 0)
         << ",";

    const std::uint64_t quad_count =
        parse_json_u64(snapshot.header.substr(
                           snapshot.header.find("\"quads\"") == std::string::npos
                               ? snapshot.header.size()
                               : snapshot.header.find("\"quads\"")),
                       "count", 0);
    const auto vectors_pos = snapshot.header.find("\"vectors\"");
    const std::uint64_t vector_count =
        vectors_pos == std::string::npos
            ? 0
            : parse_json_u64(snapshot.header.substr(vectors_pos), "count", 0);
    body << "\"quads\":" << quad_count << ","
         << "\"vectors\":" << vector_count << "}";
  }
  body << "]}\n";
  respond(fd, 200, "OK", "application/json; charset=utf-8", body.str());
}

void respond_monitor_clear(int fd) {
  clear_monitor_snapshots();
  respond(fd, 200, "OK", "application/json; charset=utf-8",
          "{\"ok\":true}\n");
}

void handle_request(int fd, const Request &req) {
  if (req.path == "/monitor-clear") {
    if (req.method != "POST" && req.method != "GET") {
      respond(fd, 405, "Method Not Allowed", "text/plain; charset=utf-8",
              "method not allowed\n");
      return;
    }
    respond_monitor_clear(fd);
    return;
  }

  if (req.method != "GET") {
    respond(fd, 405, "Method Not Allowed", "text/plain; charset=utf-8",
            "method not allowed\n");
    return;
  }

  if (req.path == "/monitor.bin") {
    respond_monitor_snapshot(fd, req);
    return;
  }
  if (req.path == "/monitor-info.json") {
    respond_monitor_info(fd);
    return;
  }
  if (req.path == "/monitor-list.json") {
    respond_monitor_list(fd);
    return;
  }

  const std::string file = route_to_file(req.path);
  if (file.empty()) {
    respond(fd, 404, "Not Found", "text/plain; charset=utf-8", "not found\n");
    return;
  }

  const auto asset = find_asset(file);
  const std::string body = asset.empty() ? "" : read_file(asset);
  if (body.empty()) {
    respond(fd, 404, "Not Found", "text/plain; charset=utf-8",
            missing_asset_message(file));
    return;
  }

  respond(fd, 200, "OK", content_type(file), body);
}

int listen_socket(int port) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    throw std::runtime_error(std::strerror(errno));
  }

  int yes = 1;
  ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(static_cast<uint16_t>(port));
  if (::bind(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) < 0) {
    ::close(fd);
    throw std::runtime_error(std::strerror(errno));
  }
  if (::listen(fd, 16) < 0) {
    ::close(fd);
    throw std::runtime_error(std::strerror(errno));
  }
  return fd;
}

} // namespace

int main(int argc, char **argv) {
  const int port = argc > 1 ? std::atoi(argv[1]) : 8080;
  const int monitor_port = argc > 2 ? std::atoi(argv[2]) : port + 1;
  try {
    init_asset_roots(argv[0]);
    g_monitor_port = monitor_port;
    const int server = listen_socket(port);
    const int monitor_server = listen_socket(monitor_port);
    std::cout << "SVIZ server listening on http://127.0.0.1:" << port << "\n";
    std::cout << "Monitor ingest socket listening on 127.0.0.1:" << monitor_port
              << "\n";
    std::cout << "Serving web client and WebAssembly mesh generator\n";
    std::cout << "Asset search roots:\n";
    for (const auto &root : g_asset_roots) {
      std::cout << "  " << root << "\n";
    }

    for (;;) {
      fd_set readfds;
      FD_ZERO(&readfds);
      FD_SET(server, &readfds);
      FD_SET(monitor_server, &readfds);
      const int max_fd = std::max(server, monitor_server);
      if (::select(max_fd + 1, &readfds, nullptr, nullptr, nullptr) < 0) {
        continue;
      }

      if (FD_ISSET(server, &readfds)) {
        sockaddr_in client_addr{};
        socklen_t client_len = sizeof(client_addr);
        const int client = ::accept(
            server, reinterpret_cast<sockaddr *>(&client_addr), &client_len);
        if (client >= 0) {
          try {
            handle_request(client, read_request(client));
          } catch (const std::exception &e) {
            respond(client, 400, "Bad Request", "text/plain; charset=utf-8",
                    std::string("bad request: ") + e.what() + "\n");
          }
          ::close(client);
        }
      }

      if (FD_ISSET(monitor_server, &readfds)) {
        sockaddr_in client_addr{};
        socklen_t client_len = sizeof(client_addr);
        const int client =
            ::accept(monitor_server, reinterpret_cast<sockaddr *>(&client_addr),
                     &client_len);
        if (client >= 0) {
          std::thread(handle_monitor_ingest, client).detach();
        }
      }
    }
  } catch (const std::exception &e) {
    std::cerr << "sviz_server: " << e.what() << "\n";
    return 1;
  }
}
