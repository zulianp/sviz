#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
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
};

struct MonitorSnapshot {
  std::uint64_t version{0};
  std::string header;
  std::vector<char> payload;
};

std::vector<std::filesystem::path> g_asset_roots;
std::mutex g_monitor_mutex;
MonitorSnapshot g_monitor;
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

std::size_t yaml_message_end(const std::vector<char> &buffer) {
  const std::string marker = "\n...\n";
  if (buffer.size() < marker.size()) {
    return std::string::npos;
  }

  for (std::size_t i = 0; i + marker.size() <= buffer.size(); ++i) {
    bool found = true;
    for (std::size_t j = 0; j < marker.size(); ++j) {
      if (buffer[i + j] != marker[j]) {
        found = false;
        break;
      }
    }
    if (found) {
      return i + marker.size();
    }
  }

  if (buffer.size() >= 4 && buffer[0] == '.' && buffer[1] == '.' &&
      buffer[2] == '.' && buffer[3] == '\n') {
    return 4;
  }
  return std::string::npos;
}

std::string trim_copy(std::string value) {
  while (!value.empty() && (value.back() == '\r' || value.back() == '\n' ||
                            value.back() == ' ' || value.back() == '\t')) {
    value.pop_back();
  }
  std::size_t first = 0;
  while (first < value.size() &&
         (value[first] == ' ' || value[first] == '\t')) {
    ++first;
  }
  return value.substr(first);
}

std::uint64_t parse_binary_bytes(const std::string &header) {
  std::istringstream lines(header);
  std::string line;
  while (std::getline(lines, line)) {
    const auto colon = line.find(':');
    if (colon == std::string::npos) {
      continue;
    }
    const std::string key = trim_copy(line.substr(0, colon));
    if (key == "binary_bytes") {
      return std::stoull(trim_copy(line.substr(colon + 1)));
    }
  }
  throw std::runtime_error("monitor header missing binary_bytes");
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

void handle_monitor_ingest(int fd) {
  try {
    std::vector<char> buffer;
    std::size_t header_bytes = std::string::npos;
    while (header_bytes == std::string::npos) {
      if (!recv_more(fd, buffer)) {
        throw std::runtime_error(
            "monitor sender closed before YAML header end");
      }
      if (buffer.size() > 1024 * 1024) {
        throw std::runtime_error("monitor YAML header exceeds 1 MiB");
      }
      header_bytes = yaml_message_end(buffer);
    }

    const std::string header(buffer.data(), buffer.data() + header_bytes);
    const std::uint64_t payload_bytes = parse_binary_bytes(header);
    if (payload_bytes > 1024ull * 1024ull * 1024ull) {
      throw std::runtime_error("monitor payload exceeds 1 GiB");
    }

    while (buffer.size() < header_bytes + payload_bytes) {
      if (!recv_more(fd, buffer)) {
        throw std::runtime_error(
            "monitor sender closed before binary payload end");
      }
    }

    MonitorSnapshot next;
    next.header = header;
    next.payload.assign(
        buffer.begin() + static_cast<std::ptrdiff_t>(header_bytes),
        buffer.begin() +
            static_cast<std::ptrdiff_t>(header_bytes + payload_bytes));
    {
      std::lock_guard<std::mutex> lock(g_monitor_mutex);
      next.version = g_monitor.version + 1;
      g_monitor = std::move(next);
    }
    std::cout << "Monitor snapshot received: " << payload_bytes << " bytes\n";
  } catch (const std::exception &e) {
    std::cerr << "monitor ingest: " << e.what() << "\n";
  }
  ::close(fd);
}

void respond_monitor_snapshot(int fd) {
  MonitorSnapshot snapshot;
  {
    std::lock_guard<std::mutex> lock(g_monitor_mutex);
    snapshot = g_monitor;
  }

  if (snapshot.version == 0) {
    respond_empty(fd, 204, "No Content");
    return;
  }

  std::string body;
  body.reserve(snapshot.header.size() + snapshot.payload.size());
  body.append(snapshot.header);
  body.append(snapshot.payload.data(), snapshot.payload.size());
  respond(fd, 200, "OK", "application/octet-stream", body);
}

void respond_monitor_info(int fd) {
  std::uint64_t version = 0;
  {
    std::lock_guard<std::mutex> lock(g_monitor_mutex);
    version = g_monitor.version;
  }

  std::ostringstream body;
  body << "{"
       << "\"version\":" << version << ","
       << "\"ingest_host\":\"127.0.0.1\","
       << "\"ingest_port\":" << g_monitor_port << "}\n";
  respond(fd, 200, "OK", "application/json; charset=utf-8", body.str());
}

void handle_request(int fd, const Request &req) {
  if (req.method != "GET") {
    respond(fd, 405, "Method Not Allowed", "text/plain; charset=utf-8",
            "method not allowed\n");
    return;
  }

  if (req.path == "/monitor.bin") {
    respond_monitor_snapshot(fd);
    return;
  }
  if (req.path == "/monitor-info.json") {
    respond_monitor_info(fd);
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
