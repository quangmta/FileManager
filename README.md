# FileScope — trình quản lý tập tin Ubuntu

Ứng dụng web tiếng Việt để duyệt và thao tác trên một vùng thư mục được cấu hình của máy Ubuntu. Giao diện dùng Flask, SQLite và JavaScript/CSS tĩnh; không cần Node.js. Quyền truy cập được giới hạn bằng tài khoản ứng dụng và quyền Unix của tài khoản chạy dịch vụ.

## Chức năng

- Duyệt cây thư mục và danh sách tệp; xem kích thước, quyền Unix, thời gian sửa đổi.
- Xem trực tiếp văn bản, mã nguồn, JSON/CSV, PDF và ảnh phổ biến trong tab trình duyệt mới; HTML được hiển thị dưới dạng văn bản thuần.
- Tải nhiều tệp lên, tải tệp xuống; tạo, đổi tên, xóa tệp/thư mục và `chmod`.
- Tải thư mục xuống dạng ZIP; tải ZIP lên và giải nén an toàn trong thư mục đang mở, có giới hạn số mục/kích thước, chống path traversal và xung đột tên.
- Tìm kiếm đệ quy theo tên, loại, dung lượng và ngày sửa đổi; kết quả tối đa 1.000 mục.
- Tiến độ, tốc độ và nút hủy khi tải lên; trình duyệt quản lý tiến độ/hủy tải xuống. Kiểm tra dung lượng trống trước khi ghi và cảnh báo phân vùng gần mức dự phòng.
- Thống kê dung lượng đã dùng/còn trống trên các phân vùng gắn kết.
- Tài khoản `read` (chỉ xem/tải), `write` (thêm/sửa/xóa/chmod), `admin` (toàn quyền và quản lý người dùng/nhật ký).
- Nhật ký đăng nhập/thất bại, tải lên, CRUD, chmod và quản lý tài khoản; lưu SQLite, hiển thị 500 sự kiện gần nhất.
- Phiên được thu hồi phía máy chủ khi hết hạn không hoạt động; admin xem/thu hồi phiên khác và tải/khôi phục bản sao lưu tài khoản + nhật ký.
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
2. Chọn thư mục từ cây bên trái hoặc breadcrumb. Dùng nút ←/→ phía trên để quay lại/tiến tới lịch sử thư mục. Bấm tên tệp hoặc biểu tượng xem trước để mở định dạng hỗ trợ trong tab mới; dùng biểu tượng tải xuống cho tệp cần lưu về máy. Thư mục mở khi bấm tên.
3. Dùng các nút trên trang để tải lên, tạo thư mục/tệp. Các nút ở từng dòng hỗ trợ Copy, Cut, đổi tên, đổi quyền dạng bát phân (ví dụ `640`) và xóa. Chọn **Paste here** sau khi mở thư mục đích; Copy có thể dán nhiều lần, Cut sẽ được xóa khỏi clipboard sau khi dán thành công.
4. Nút **ZIP** tải tệp `.zip` lên rồi giải nén vào thư mục đang mở. Hệ thống không cho ZIP ghi đè mục đã có; ZIP lỗi, có đường dẫn tuyệt đối/`..`, symbolic link, tỷ lệ nén bất thường hoặc vượt giới hạn sẽ bị từ chối. Tệp ZIP tải lên chịu `FILEMANAGER_MAX_UPLOAD`; tổng dữ liệu giải nén và số mục chịu `FILEMANAGER_MAX_EXTRACTED`/`FILEMANAGER_MAX_ARCHIVE_ENTRIES`.
5. Dùng biểu mẫu **Tìm trong thư mục này và thư mục con** để tìm theo tên và lọc theo loại, dung lượng KB hoặc ngày sửa đổi. Ngày mở trong popover nổi; nhấn lại tiêu đề hoặc bấm bên ngoài để thu gọn. Khoảng ngày đã chọn vẫn hiện trên tiêu đề. Kết quả tối đa 1.000 mục và hệ thống quét tối đa `FILEMANAGER_MAX_SEARCH_SCAN` mục.
6. Trong bảng, nhấn tiêu đề cột để sắp xếp; nhấn lại để đảo chiều. Nút ▾ cạnh tiêu đề mở bộ lọc theo tên, kích thước, quyền hoặc ngày. Kéo vạch ⋮ để đổi rộng cột; bảng hiện thanh cuộn ngang nếu vượt vùng xem. Tên dài được rút gọn trong ô.
7. Tải lên hiển thị phần trăm, tốc độ và nút **Hủy**. Nút này hủy request từ trình duyệt; nếu server đã hoàn tất ghi trước khi nhận lệnh hủy thì tệp có thể đã được lưu. Download dùng trình tải của trình duyệt để hỗ trợ tiến độ và hủy mà không phải giữ toàn bộ file trong bộ nhớ giao diện. Upload/giải nén bị chặn nếu không đủ dung lượng trống hoặc sẽ làm mức trống thấp hơn `FILEMANAGER_MIN_FREE_SPACE`.
8. Admin vào **Quản trị** để tạo tài khoản `read`, `write`, `admin`, xem nhật ký/phiên và thu hồi phiên khác. Phiên tự hết hạn sau `FILEMANAGER_SESSION_IDLE` giây không hoạt động (mặc định 30 phút); phiên hiện tại được đánh dấu và không thể thu hồi từ chính nó.
9. Trong **Sao lưu & khôi phục**, tải JSON backup trước khi khôi phục. Backup chứa tài khoản (bao gồm password hash) và tối đa 100.000 sự kiện audit, kèm cờ nếu audit bị cắt bớt. Khôi phục thay thế danh sách tài khoản và audit, yêu cầu xác nhận và giữ phiên admin hiện tại nếu tài khoản đó có trong backup. Thông tin root/giới hạn trong backup chỉ để tham khảo; khôi phục không đổi biến môi trường, secret hay nội dung file. Giữ file backup ở nơi được bảo vệ như database.
10. Vào **Dung lượng ổ đĩa** để xem phân vùng, phần trăm dùng, dung lượng còn trống. Cảnh báo hiện trên phân vùng có mức trống thấp hơn ngưỡng dự phòng.

Tùy chọn độ rộng cột được lưu trong trình duyệt đang dùng. Copy/Cut clipboard cũng chỉ nằm trong giao diện trình duyệt hiện tại.

`FILEMANAGER_ROOT` là ranh giới bảo mật ứng dụng. Đường dẫn `..`, đường dẫn tuyệt đối và symbolic link bị từ chối; thư mục dữ liệu ứng dụng không được liệt kê. Tệp hệ thống vẫn chịu kiểm soát quyền Unix của user chạy dịch vụ. Không cấu hình root là `/` nếu không thực sự cần thiết.

### Triển khai trên QNX/KR260

Ứng dụng không gọi lệnh Linux như `df`, `stat`, `zip`, không đọc `/proc/mounts` trên QNX và không phụ thuộc systemd. Python/Flask, SQLite, ZIP, TLS và các API filesystem phải có sẵn trong image target. Đây là hướng dẫn porting: cần build và kiểm chứng trên đúng image/BSP KR260 trước khi đưa vào sử dụng; kiểm tra trên Ubuntu không chứng minh ABI hoặc driver QNX tương thích.

#### 1. Kiểm tra image và Python

Đảm bảo BSP/network driver cho KR260 hoạt động, thiết bị có địa chỉ IP và có một mount dữ liệu persistent ghi được. Xác nhận Python target và module ABI ngay trên board:

```sh
uname -a
python3.11 -V
python3.11 -c 'import ssl, sqlite3, zlib, zipfile; print(ssl.OPENSSL_VERSION)'
```

Đừng cài wheel hoặc thư viện native build cho Ubuntu lên QNX. Cần dùng package Python target được build cho đúng QNX SDP/architecture, hoặc build/cross-compile từ QNX SDP host tools. Tài liệu QNX hiện có Python 3.11 cho SDP 7.1; ghi chú SDP 8.0.3 có Python 3.13. Vì vậy Python 3.11 trên một image SDP 8.0/KR260 có thể là bản tùy biến; phải xác nhận nguồn build, ABI và tương thích package. Đóng gói các dependency của `requirements.txt` (Flask, Werkzeug và dependency gián tiếp) cho đúng target. `gunicorn` trong requirements chỉ dành cho Linux; không dùng trên QNX nếu chưa port và kiểm thử riêng.

Chép mã nguồn (`app.py`, `static/`, `tools/`) và Python packages tương thích vào image/board. Checker giúp báo thiếu tính năng trước khi khởi chạy:

```sh
python3.11 tools/check_qnx_runtime.py
```

Checker cần kết thúc mã 0. Nó kiểm tra module, SQLite, ZIP Deflate, TLS context, loopback socket và filesystem cơ bản; không kiểm tra BSP, certificate chain, network từ xa, độ bền ổ đĩa hay khả năng phục vụ tải đồng thời.

#### 2. Chọn thư mục và quyền ghi

Ví dụ dưới đây giả định phân vùng dữ liệu được mount tại `/fs/data`; thay bằng mount point thực tế của image. Không dùng vùng dữ liệu tạm trong RAM để lưu database hoặc file người dùng. Cấp quyền tối thiểu cho user dịch vụ, và bảo đảm filesystem hỗ trợ các thao tác POSIX cần dùng như `chmod`, rename nguyên tử (`os.replace`) và SQLite locking.

```sh
mkdir -p /fs/data/filescope/root /fs/data/filescope/state /fs/data/filescope/tmp
export FILEMANAGER_ROOT=/fs/data/filescope/root
export FILEMANAGER_DB=/fs/data/filescope/state/filemanager.sqlite3
export FILEMANAGER_TMP=/fs/data/filescope/tmp
export FILEMANAGER_MOUNTS=/,/fs/data
export FILEMANAGER_MIN_FREE_SPACE=67108864
export FILEMANAGER_SECRET='THAY_BANG_CHUOI_NGAU_NHIEN_DAI'
```

Tạo secret ngẫu nhiên trên máy tin cậy rồi chuyển vào cấu hình bảo mật của image; không commit secret vào Git. Tài khoản QNX chạy app cần quyền đọc/ghi root và database, ghi thư mục tạm, cùng các quyền Unix mà người dùng web được phép thao tác. App không tự nâng quyền thành root. `FILEMANAGER_MOUNTS` là danh sách mount point phân cách bằng `:`; trên QNX nên khai báo rõ các mount muốn hiển thị ở trang dung lượng. Root được tự thêm nếu thiếu. Nếu không đặt biến này, QNX chỉ báo mount của `FILEMANAGER_ROOT`.

#### 3. Tạo admin và khởi chạy thử

```sh
python3.11 app.py create-admin admin
python3.11 app.py serve --host 0.0.0.0 --port 8080
```

Từ máy khách truy cập `http://<IP-KR260>:8080`. Lệnh `serve` dùng Flask development server, chỉ thích hợp bring-up trong mạng tin cậy. Để triển khai thật, chạy app dưới một supervisor/startup service của image QNX với user ít quyền, tự khởi động lại khi lỗi và cấu hình log/giám sát theo BSP; không dùng unit systemd Linux. Chưa có WSGI server production được xác nhận trên QNX trong repo này.

Để bật HTTPS trực tiếp, cài certificate/private key phù hợp target rồi chạy:

```sh
export FILEMANAGER_HTTPS=1
python3.11 app.py serve --host 0.0.0.0 --port 8443 --cert /path/to/server.crt --key /path/to/server.key
```

Truy cập `https://<IP-hoac-hostname-KR260>:8443`; trình duyệt cần tin cậy certificate. Nếu TLS/network stack của image không hoạt động với Python `ssl`, cần sửa image/package SSL thay vì bỏ qua TLS khi truy cập từ mạng không tin cậy. Bảo vệ private key và database bằng quyền file của QNX.

#### 4. Thử nghiệm trên target

Thực hiện các ca TC-01 đến TC-21 bên dưới với dữ liệu thử, đặc biệt TC-04/05/06/08/10/12/13/18. Xác nhận các phân vùng trong `FILEMANAGER_MOUNTS` đúng với mount thật, upload lớn không làm đầy RAM, database vẫn tồn tại sau reboot, quyền file đúng với filesystem đang dùng, và truy cập HTTPS được từ máy khách. Kết quả trên Linux chỉ kiểm chứng chức năng chung; chỉ ghi nhận tương thích QNX sau khi các ca này chạy đạt trên chính board/image.

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
| TC-11 | Mở `.txt`, `.pdf`, ảnh và `.html` từ danh sách | Văn bản/PDF/ảnh hiển thị inline; HTML hiện như văn bản thuần, không chạy script |
| TC-12 | Tải ZIP hợp lệ có thư mục lồng nhau và thư mục rỗng | Giải nén đúng nội dung vào thư mục đang mở |
| TC-13 | ZIP chứa `../`, symlink, archive bomb hoặc tên trùng | Bị từ chối, không ghi đè và không tạo tệp ngoài đích |
| TC-14 | Tìm theo tên/loại/dung lượng/ngày sửa đổi | Chỉ hiển thị mục phù hợp; kết quả lớn được đánh dấu giới hạn |
| TC-15 | Tải nhiều tệp, hủy giữa chừng, ổ còn ít dung lượng | Có tiến độ; hủy request; upload bị chặn nếu không đủ dung lượng/mức dự phòng |
| TC-16 | Không hoạt động quá `FILEMANAGER_SESSION_IDLE`; admin thu hồi phiên | API hết hạn trả HTTP 401; phiên bị thu hồi phải đăng nhập lại |
| TC-17 | Tải backup rồi khôi phục JSON hợp lệ/không hợp lệ | Backup chỉ có tài khoản + audit; JSON sai bị từ chối; restore có xác nhận và audit event |
| TC-18 | Chạy `tools/check_qnx_runtime.py` trên image KR260/QNX | Báo rõ runtime/module/filesystem còn thiếu; không thay thế kiểm thử BSP thực tế |
| TC-19 | Mở/thu gọn bộ chọn ngày trong biểu mẫu tìm kiếm | Bộ chọn nổi, không làm thay đổi chiều cao thanh; khoảng ngày vẫn hiện sau khi thu gọn; click ngoài đóng popover |
| TC-20 | Sắp xếp và lọc cột trong lúc đang xem kết quả tìm kiếm | Sắp xếp/lọc áp dụng lên kết quả hiện tại; Xóa tìm kiếm trở lại danh sách thư mục |
| TC-21 | Mở form có trường bắt buộc rồi nhấn **Hủy** hoặc **×** khi để trống | Modal đóng ngay, không hiện thông báo validation; nhấn **Xác nhận** vẫn kiểm tra trường bắt buộc |

## Cấu hình

| Biến | Mặc định | Mô tả |
|---|---|---|
| `FILEMANAGER_ROOT` | thư mục chứa `app.py` | Gốc vùng dữ liệu được quản lý |
| `FILEMANAGER_DB` | `<project>/.filescope/filemanager.sqlite3` | Database tài khoản và nhật ký |
| `FILEMANAGER_SECRET` | không đặt | Bắt buộc chạy server; chuỗi ngẫu nhiên bí mật |
| `FILEMANAGER_HTTPS` | `0` | Đặt `1` khi trình duyệt luôn dùng HTTPS |
| `FILEMANAGER_MAX_UPLOAD` | `1073741824` | Kích thước tải lên tối đa theo byte |
| `FILEMANAGER_MAX_EXTRACTED` | `2147483648` | Tổng byte giải nén hoặc đóng gói thư mục tối đa |
| `FILEMANAGER_MAX_ARCHIVE_ENTRIES` | `10000` | Số mục tối đa trong archive |
| `FILEMANAGER_MAX_SEARCH_SCAN` | `100000` | Số mục tối đa quét trong một tìm kiếm |
| `FILEMANAGER_MAX_BACKUP` | `33554432` | Kích thước backup JSON tối đa |
| `FILEMANAGER_MIN_FREE_SPACE` | `67108864` | Dung lượng phải còn lại sau upload/giải nén |
| `FILEMANAGER_SESSION_IDLE` | `1800` | Thời gian idle tối đa của phiên, đơn vị giây |
| `FILEMANAGER_MOUNTS` | tự dò trên Linux; QNX chỉ dùng root | Danh sách mount points phân cách bằng `:` (QNX nên đặt tường minh) |
| `FILEMANAGER_TMP` | thư mục tạm mặc định của Python | Thư mục writable dùng để spool upload và tạo ZIP; trên thiết bị nên đặt nơi có dung lượng phù hợp |

Đặt `FILEMANAGER_MIN_FREE_SPACE=0` nếu muốn tắt phần dung lượng dự phòng. Không nên đặt quá cao trên thiết bị có phân vùng nhỏ; giá trị này vừa tạo cảnh báo trên trang dung lượng vừa chặn upload/giải nén có thể làm dung lượng trống giảm xuống dưới ngưỡng.
