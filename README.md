# FileScope — trình quản lý tập tin Ubuntu

Ứng dụng web tiếng Việt để duyệt và thao tác trên một vùng thư mục được cấu hình của máy Ubuntu. Giao diện dùng Flask, SQLite và JavaScript/CSS tĩnh; không cần Node.js. Quyền truy cập được giới hạn bằng tài khoản ứng dụng và quyền Unix của tài khoản chạy dịch vụ.

## Chức năng

- Duyệt cây thư mục và danh sách tệp; xem kích thước, quyền Unix, thời gian sửa đổi.
- Tải nhiều tệp lên, tải tệp xuống; tạo, đổi tên, xóa tệp/thư mục và `chmod`.
- Thống kê dung lượng đã dùng/còn trống trên các phân vùng gắn kết.
- Tài khoản `read` (chỉ xem/tải), `write` (thêm/sửa/xóa/chmod), `admin` (toàn quyền và quản lý người dùng/nhật ký).
- Nhật ký đăng nhập/thất bại, tải lên, CRUD, chmod và quản lý tài khoản; lưu SQLite, hiển thị 500 sự kiện gần nhất.
- HTTP để chạy thử trong mạng tin cậy; HTTPS bằng TLS trực tiếp hoặc reverse proxy Nginx.

## Cài đặt nhanh trên Ubuntu

```bash
sudo apt update
sudo apt install -y python3 python3-venv
cd /đường/dẫn/FileSystem
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Chọn một thư mục được phép quản lý. Mặc định là chính thư mục dự án. Nên dùng một vùng dữ liệu chuyên dụng thay vì cấp quyền vào `/` hoặc toàn bộ `/home`:

```bash
mkdir -p "$HOME/filescope-root"
export FILEMANAGER_ROOT="$HOME/filescope-root"
export FILEMANAGER_DB="$HOME/.local/share/filescope/filemanager.sqlite3"
export FILEMANAGER_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
python app.py create-admin admin
```

Lệnh tạo tài khoản sẽ hỏi mật khẩu (tối thiểu 12 ký tự); không truyền mật khẩu qua đối số dòng lệnh. Chạy máy chủ trong phiên terminal:

```bash
python app.py serve --host 0.0.0.0 --port 8080
```

Truy cập `http://IP-may-Ubuntu:8080`. Mở cổng 8080 trên firewall chỉ khi cần trong mạng tin cậy. Mọi thao tác trên đĩa chạy dưới tài khoản Unix khởi động dịch vụ; ứng dụng không tự nâng quyền `root`.

### HTTPS

Để thử TLS trực tiếp, tạo chứng chỉ phù hợp tên máy/địa chỉ IP (chứng chỉ tự ký sẽ hiện cảnh báo trình duyệt), rồi chạy:

```bash
export FILEMANAGER_HTTPS=1
python app.py serve --host 0.0.0.0 --port 8443 --cert /etc/ssl/certs/filescope.crt --key /etc/ssl/private/filescope.key
```

Khi triển khai lâu dài, khuyến nghị chạy Gunicorn chỉ trên localhost sau Nginx/HTTPS với chứng chỉ Let's Encrypt hoặc chứng chỉ nội bộ. Ví dụ Nginx:

```nginx
server {
    listen 443 ssl;
    server_name files.example.internal;
    ssl_certificate /etc/letsencrypt/live/files.example.internal/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.internal/privkey.pem;
    client_max_body_size 1025m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

Chạy Gunicorn với cùng biến `FILEMANAGER_ROOT`, `FILEMANAGER_DB`, `FILEMANAGER_SECRET`; đặt `FILEMANAGER_HTTPS=1` để bật cookie phiên `Secure`. Không phơi cổng Gunicorn ra mạng. Cấu hình giới hạn tải lên phía proxy phải tương ứng `FILEMANAGER_MAX_UPLOAD` (mặc định 1 GiB).

### Chạy như dịch vụ systemd

Tạo tài khoản dịch vụ riêng và cấp quyền Unix tối thiểu cần cho thư mục dữ liệu. Tệp mẫu dưới đây cần sửa đường dẫn, `User`, `Group` và biến môi trường cho máy của bạn:

```ini
# /etc/systemd/system/filescope.service
[Unit]
Description=FileScope web file manager
After=network.target

[Service]
Type=simple
User=filescope
Group=filescope
WorkingDirectory=/opt/filescope
Environment=FILEMANAGER_ROOT=/srv/filescope-data
Environment=FILEMANAGER_DB=/var/lib/filescope/filemanager.sqlite3
Environment=FILEMANAGER_SECRET=THAY_BANG_CHUOI_NGAU_NHIEN_DAI
Environment=FILEMANAGER_HTTPS=1
ExecStart=/opt/filescope/.venv/bin/gunicorn --workers 2 --bind 127.0.0.1:8080 --timeout 120 app:app
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/filescope-data /var/lib/filescope

[Install]
WantedBy=multi-user.target
```

`ProtectHome=true` cần đổi nếu thư mục quản lý nằm dưới `/home`. Khởi tạo database/tài khoản admin một lần dưới đúng user và cùng biến môi trường, sau đó `sudo systemctl daemon-reload && sudo systemctl enable --now filescope`. Theo dõi bằng `journalctl -u filescope -f`. Bảo vệ file secret và database bằng quyền đọc/ghi chỉ dành cho user dịch vụ. Sao lưu database định kỳ; nhật ký giữ trong DB, giao diện trả 500 sự kiện mới nhất.

## Sử dụng

1. Mở địa chỉ HTTPS, đăng nhập bằng tài khoản admin đã tạo.
2. Chọn thư mục từ cây bên trái hoặc breadcrumb. Dùng nút ←/→ phía trên để quay lại/tiến tới lịch sử thư mục. Tệp có thể tải xuống; thư mục mở khi bấm tên.
3. Dùng các nút trên trang để tải lên, tạo thư mục/tệp. Menu từng dòng cho phép đổi tên, quyền dạng bát phân (ví dụ `640`) hoặc xóa.
4. Admin vào **Quản trị** để tạo tài khoản với vai trò `read`, `write`, hoặc `admin`, và xem nhật ký thao tác.
5. Vào **Dung lượng ổ đĩa** để xem phân vùng, phần trăm dùng, dung lượng còn trống.

`FILEMANAGER_ROOT` là ranh giới bảo mật ứng dụng. Đường dẫn `..`, đường dẫn tuyệt đối và symbolic link bị từ chối; thư mục dữ liệu ứng dụng không được liệt kê. Tệp hệ thống vẫn chịu kiểm soát quyền Unix của user chạy dịch vụ. Không cấu hình root là `/` nếu không thực sự cần thiết.

## Kiểm tra

Chạy kiểm tra tự động từ thư mục dự án:

```bash
python3 -m unittest discover -s tests -v
```

Các trường hợp kiểm tra chấp nhận thủ công:

| ID | Trường hợp | Kết quả mong đợi |
|---|---|---|
| TC-01 | Truy cập chưa đăng nhập `/api/list` | HTTP 401; giao diện yêu cầu đăng nhập |
| TC-02 | Đăng nhập đúng/sai mật khẩu | Đúng vào ứng dụng; sai báo lỗi chung và không tạo phiên |
| TC-03 | Tài khoản `read` gọi API tạo/xóa/chmod | HTTP 403; nội dung không đổi |
| TC-04 | `write` tạo thư mục, tạo tệp, đổi tên, chmod `640`, xóa | Mỗi thay đổi đúng; quyền hiển thị dạng Unix |
| TC-05 | Dùng đường dẫn `../` hoặc symlink trỏ ra ngoài root | Bị từ chối; tệp ngoài không bị đọc/thay đổi |
| TC-06 | Tải lên một/nhiều tệp; tải xuống | Tệp lưu đúng nội dung và tải về đúng byte |
| TC-07 | Tải tệp vượt `FILEMANAGER_MAX_UPLOAD` | HTTP 413, hiển thị thông báo giới hạn |
| TC-08 | Xem trang dung lượng | Các mount có tổng/đã dùng/còn trống nhất quán với `df -h` |
| TC-09 | Admin tạo user, xem audit; user thường gọi `/api/audit` | Admin thành công; user thường nhận HTTP 403 |
| TC-10 | Dùng HTTPS qua proxy/chứng chỉ hợp lệ | Trình duyệt hiển thị kết nối TLS; cookie phiên có cờ Secure |

## Cấu hình

| Biến | Mặc định | Mô tả |
|---|---|---|
| `FILEMANAGER_ROOT` | thư mục chứa `app.py` | Gốc vùng dữ liệu được quản lý |
| `FILEMANAGER_DB` | `<project>/.filescope/filemanager.sqlite3` | Database tài khoản và nhật ký |
| `FILEMANAGER_SECRET` | không đặt | Bắt buộc chạy server; chuỗi ngẫu nhiên bí mật |
| `FILEMANAGER_HTTPS` | `0` | Đặt `1` khi trình duyệt luôn dùng HTTPS |
| `FILEMANAGER_MAX_UPLOAD` | `1073741824` | Kích thước tải lên tối đa theo byte |
