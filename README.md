# FileScope — trình quản lý tập tin Ubuntu

Ứng dụng web tiếng Việt để duyệt và thao tác trên một vùng thư mục được cấu hình của máy Ubuntu. Giao diện dùng Flask, SQLite và JavaScript/CSS tĩnh; không cần Node.js. Quyền truy cập được giới hạn bằng tài khoản ứng dụng và quyền Unix của tài khoản chạy dịch vụ.

## Chức năng

- Duyệt cây thư mục và danh sách tệp; xem kích thước, quyền Unix, thời gian sửa đổi.
- Xem trực tiếp văn bản, mã nguồn, JSON/CSV, PDF và ảnh phổ biến trong tab trình duyệt mới; HTML được hiển thị dưới dạng văn bản thuần.
- Sửa trực tiếp tệp UTF-8 với số dòng và tô màu cú pháp cơ bản cho Python, JavaScript, JSON, HTML/XML, CSS, Shell, SQL, YAML và Markdown; chỉ role `write`/`admin`, có giới hạn kích thước và phát hiện thay đổi đồng thời.
- Tải nhiều tệp lên, tải tệp xuống; tạo, đổi tên, xóa tệp/thư mục và `chmod`.
- Tải thư mục xuống dạng ZIP; tải ZIP lên và giải nén an toàn trong thư mục đang mở, có giới hạn số mục/kích thước, chống path traversal và xung đột tên.
- Tìm kiếm đệ quy theo tên, loại, dung lượng và ngày sửa đổi; kết quả tối đa 1.000 mục.
- Tiến độ, tốc độ và nút hủy khi tải lên; trình duyệt quản lý tiến độ/hủy tải xuống. Kiểm tra dung lượng trống trước khi ghi và cảnh báo phân vùng gần mức dự phòng.
- **Giám sát hệ thống**: Linux lấy số liệu từ procfs; QNX lấy CPU/RAM từ `top`/`pidin`, tiến trình từ `pidin` (có fallback định dạng mặc định) và RSS từ procfs nếu image cấp quyền. Tab mạng và điều khiển tiến trình chỉ bật trên Linux.
- Trang **Bản đồ & nhật ký** chỉ đọc tile DTED `.dt2` và log CSV/JSON/JSONL/text; hỗ trợ lớp phủ nhiều quỹ đạo, biểu đồ/statistics, phân tích AGL, tìm tile theo tọa độ và xuất báo cáo.
- Tài khoản `read` (chỉ xem/tải), `write` (thêm/sửa/xóa/chmod), `admin` (toàn quyền và quản lý người dùng/nhật ký).
- Nhật ký đăng nhập/thất bại, tải lên, CRUD, chmod và quản lý tài khoản; lưu SQLite, hiển thị 500 sự kiện gần nhất.
- Phiên được thu hồi phía máy chủ khi hết hạn không hoạt động; admin xem/thu hồi phiên khác và tải/khôi phục bản sao lưu tài khoản + nhật ký.
- HTTP để chạy thử trong mạng tin cậy; HTTPS bằng TLS trực tiếp hoặc reverse proxy Nginx.

## Cấu trúc giao diện

JavaScript phía trình duyệt được chia theo nghiệp vụ trong `static/`: `common.js` chứa trạng thái dùng chung, đăng nhập và điều hướng; `files.js` xử lý duyệt/thao tác tệp; `maps.js` xử lý bản đồ và log; `system-monitor.js` xử lý giám sát tài nguyên; `admin.js` xử lý người dùng, phiên và nhật ký quản trị. `app.js` là điểm khởi chạy nhỏ. Các script được nạp bằng `defer` theo thứ tự trong `index.html`; giữ thứ tự này để các tiện ích và trạng thái dùng chung có sẵn trước khi khởi chạy.

Backend giữ cấu hình, xác thực chung và lệnh khởi chạy trong `app.py`. Các route được chia trong `routes/`: `auth.py`, `files.py`, `geo.py`, `system.py`, `transfers.py` và `admin.py`. `geodata.py` chứa bộ đọc DTED/log. Khi thêm API mới, đặt route vào module đúng nghiệp vụ; `app.py` đăng ký các module sau khi khởi tạo app và các hàm dùng chung.

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
3. Dùng các nút trên trang để tải lên, tạo thư mục/tệp. Các nút ở từng dòng hỗ trợ Copy, Cut, đổi tên, đổi quyền bằng danh sách chọn cho Chủ sở hữu/Nhóm/Người khác hoặc nhập quyền bát phân (ví dụ `640`), xóa và **Sửa nội dung** cho tệp văn bản UTF-8. Editor có số dòng và tô màu cú pháp cơ bản; phím Tab chèn 4 dấu cách. Kéo góc dưới bên phải cửa sổ editor để đổi cả chiều rộng và chiều cao. Có nút **Hoàn tác/Làm lại** và phím tắt Ctrl+Z/Ctrl+Y (⌘+Z/⌘+Y trên macOS); con trỏ tự cuộn theo dòng đang sửa. Enter xuống dòng, **Ctrl+Enter** (hoặc **⌘+Enter** trên macOS) lưu; nút **Xác nhận** cũng lưu. Lưu bị từ chối nếu file đã thay đổi từ nơi khác sau khi mở; mở lại editor để lấy nội dung mới. Chỉ role `write` và `admin` thấy nút sửa. Chọn **Paste here** sau khi mở thư mục đích; Copy có thể dán nhiều lần, Cut sẽ được xóa khỏi clipboard sau khi dán thành công.
4. Nút **ZIP** tải tệp `.zip` lên rồi giải nén vào thư mục đang mở. Hệ thống không cho ZIP ghi đè mục đã có; ZIP lỗi, có đường dẫn tuyệt đối/`..`, symbolic link, tỷ lệ nén bất thường hoặc vượt giới hạn sẽ bị từ chối. Tệp ZIP tải lên chịu `FILEMANAGER_MAX_UPLOAD`; tổng dữ liệu giải nén và số mục chịu `FILEMANAGER_MAX_EXTRACTED`/`FILEMANAGER_MAX_ARCHIVE_ENTRIES`.
5. Dùng biểu mẫu **Tìm trong thư mục này và thư mục con** để tìm theo tên và lọc theo loại, dung lượng KB hoặc ngày sửa đổi. Ngày mở trong popover nổi; nhấn lại tiêu đề hoặc bấm bên ngoài để thu gọn. Khoảng ngày đã chọn vẫn hiện trên tiêu đề. Kết quả tối đa 1.000 mục và hệ thống quét tối đa `FILEMANAGER_MAX_SEARCH_SCAN` mục.
6. Trong bảng, nhấn tiêu đề cột để sắp xếp; nhấn lại để đảo chiều. Nút ▾ cạnh tiêu đề mở bộ lọc theo tên, kích thước, quyền hoặc ngày. Kéo vạch ⋮ để đổi rộng cột; bảng hiện thanh cuộn ngang nếu vượt vùng xem. Tên dài được rút gọn trong ô.
7. Tải lên hiển thị phần trăm, tốc độ và nút **Hủy**. Nút này hủy request từ trình duyệt; nếu server đã hoàn tất ghi trước khi nhận lệnh hủy thì tệp có thể đã được lưu. Download dùng trình tải của trình duyệt để hỗ trợ tiến độ và hủy mà không phải giữ toàn bộ file trong bộ nhớ giao diện. Upload/giải nén bị chặn nếu không đủ dung lượng trống hoặc sẽ làm mức trống thấp hơn `FILEMANAGER_MIN_FREE_SPACE`.
8. Admin vào **Quản trị** để tạo tài khoản `read`, `write`, `admin`, xem nhật ký/phiên và thu hồi phiên khác. Phiên tự hết hạn sau `FILEMANAGER_SESSION_IDLE` giây không hoạt động (mặc định 30 phút); phiên hiện tại được đánh dấu và không thể thu hồi từ chính nó.
9. Trong **Sao lưu & khôi phục**, tải JSON backup trước khi khôi phục. Backup chứa tài khoản (bao gồm password hash) và tối đa 100.000 sự kiện audit, kèm cờ nếu audit bị cắt bớt. Khôi phục thay thế danh sách tài khoản và audit, yêu cầu xác nhận và giữ phiên admin hiện tại nếu tài khoản đó có trong backup. Thông tin root/giới hạn trong backup chỉ để tham khảo; khôi phục không đổi biến môi trường, secret hay nội dung file. Giữ file backup ở nơi được bảo vệ như database.
10. Vào **Giám sát hệ thống → Dung lượng ổ đĩa** để xem phân vùng, phần trăm dùng và dung lượng còn trống. Cảnh báo hiện trên phân vùng có mức trống thấp hơn ngưỡng dự phòng.
11. Trong **Giám sát hệ thống**, tab **Tiến trình** hiển thị tên, user, PID, CPU và bộ nhớ; `% CPU tổng` là phần trăm trên tổng năng lực các CPU logic của máy nên tối đa 100%. Linux lấy mẫu từ `/proc`; QNX dùng `pidin`, `top` và `/proc/<pid>/vmstat`, làm mới mỗi 5 giây. Trên QNX, tiến trình chỉ xem được, không có nút gửi tín hiệu; tab mạng bị ẩn và swap không được báo cáo. Bộ nhớ tiến trình QNX là RSS tính từ số trang trong `vmstat`; quyền truy cập procfs có thể khiến một số tiến trình trả về 0 byte. RAM/swap Linux dùng GB thập phân (1 GB = 1.000.000.000 byte); RAM QNX tính mức dùng bằng tổng trừ phần `FreeMem` còn trống từ `pidin info` và giữ đơn vị MB/GB của QNX để tránh hiển thị lệch do đổi sang GB thập phân. Nếu `pidin -F` không trả định dạng tùy chỉnh, danh sách tiến trình thử đọc định dạng mặc định của `pidin`. Trên Linux, admin chọn **Tạm dừng**, **Tiếp tục**, **Kết thúc** (TERM) hoặc **Buộc dừng** (KILL) rồi **Thực thi**. Kết thúc/buộc dừng cần xác nhận. PID 1, tiến trình root, tiến trình cùng process group với server và tên được bảo vệ không thể điều khiển. Dùng `FILEMANAGER_PROTECTED_PROCESSES` để khai báo thêm tên tiến trình cần bảo vệ.

Tùy chọn độ rộng cột được lưu trong trình duyệt đang dùng. Copy/Cut clipboard cũng chỉ nằm trong giao diện trình duyệt hiện tại.

### Bản đồ và log

Vào **Bản đồ & nhật ký**, chọn tile `.dt2` và tệp log. Trình đọc hỗ trợ định dạng DTED UHL/Data Record; phần mở rộng `.dt2` tự nó chưa đủ xác nhận định dạng. Tile mẫu `Map/n22_e105_1arc_v3.dt2` có gốc 22°N, 105°E, lưới 3601×3601 với khoảng cách 1 giây cung, phủ tới 23°N, 106°E. Mỗi profile là một kinh độ; cao độ trong profile đi từ Nam lên Bắc như `Map/read_map.cpp`. Để tải nhanh, ảnh hiển thị được giảm mẫu tối đa 256×256; bấm lên ảnh vẫn tra ô gần nhất trên lưới gốc 3601×3601. Bản đồ được tô màu theo mẫu cao độ, hiển thị bước lưới và cảnh báo checksum của các profile đã lấy mẫu. Preview chỉ giải mã các hàng được lấy mẫu và được cache trong tiến trình theo đường dẫn/kích thước/thời gian sửa đổi; tra cứu AGL đọc profile theo thứ tự cột để giảm seek ngẫu nhiên trên thiết bị lưu trữ chậm. Chọn dòng log để đối chiếu tọa độ/cao độ ghi nhận với tile đang mở. DTED lưu cao độ signed-magnitude big-endian; giá trị NoData là `0xFFFF`. Chênh cao là phép trừ số học; chỉ diễn giải khi hai nguồn dùng cùng đơn vị và mốc cao độ. Thanh thời gian và **Phát lại** duyệt log theo timestamp; chọn hệ số tốc độ từ `0,5×` đến `20×` cạnh nút phát. Các dòng thiếu timestamp dùng khoảng mặc định 5 giây trước khi áp dụng hệ số. Bộ lọc hỗ trợ từ khóa/ngày và **Xuất CSV** tải các bản ghi đang lọc.

Log có thể là CSV, JSON array/object, JSON Lines, hoặc văn bản từng dòng. Trình đọc nhận các tên trường phổ biến như `latitude`/`lat`, `longitude`/`lon`/`lng`, `altitude`/`elevation`/`height`, `timestamp`/`time` và `speed_mps`/`groundspeed`; tốc độ được hiểu là m/s. Trường tọa độ trong object con `position`, `coordinates` hoặc `location` cũng được nhận. Dòng không có tọa độ vẫn xuất hiện trong bảng nhưng không được vẽ trên bản đồ. File log bị giới hạn 5.000 bản ghi trả về và tối đa `FILEMANAGER_MAX_GEO_FILE` byte.

Có thể thêm tối đa bốn quỹ đạo log làm lớp phủ để so sánh. Biểu đồ đặt cao độ bay và cao độ DTED trên cùng trục mét; vùng tô giữa hai đường biểu thị chênh cao AGL. Biểu đồ tốc độ được tách riêng. Dùng chế độ **Chọn vùng** rồi kéo một khung trên biểu đồ để zoom cả trục thời gian và cao độ; chọn **Di chuyển** rồi kéo ngang/dọc để pan. Các nút +/− và đặt lại vẫn dùng được; cả hai biểu đồ dùng chung cửa sổ thời gian và nhấn để chọn thời điểm trên bản đồ. Phần thống kê tính quãng đường, thời lượng, tốc độ, cao độ và số điểm ngoài tile. **Phân tích theo địa hình** tra cao độ DTED theo lô, tính AGL (cao độ log trừ cao độ địa hình), tô đỏ các điểm thấp hơn ngưỡng đặt trong giao diện và bổ sung kết quả vào CSV. Danh mục tile báo các cặp vùng chồng diện tích và dải trống trong khung bao; nhập tọa độ để tìm tile chứa điểm. **Báo cáo HTML** tải một trang độc lập gồm thống kê, hình bản đồ/biểu đồ và các điểm dưới ngưỡng. Các kết quả chỉ phục vụ xem xét log, không phải cảnh báo bay thời gian thực.

Đặt `FILEMANAGER_GEO_ROOT` vào thư mục bản đồ/log bên trong `FILEMANAGER_ROOT` nếu không muốn quét toàn bộ vùng quản lý. Thư mục `Map` kèm tile mẫu, tài liệu định dạng và `read_map.cpp` làm tài liệu tham chiếu. Parser web đọc trực tiếp DTED chuẩn, không gọi hay phụ thuộc chương trình C++; tile theo định dạng riêng sẽ được liệt kê kèm lỗi cho đến khi có đặc tả parser tương ứng.

Các tệp `Map/n22_e106_synthetic.dt2`, `n22_e107_synthetic.dt2`, `n22_e108_synthetic.dt2` và `uav_route_4_tiles_simulation.csv` được tạo để thử giao diện. Ba tile mới là địa hình tổng hợp nối mép từ tile gốc, **không phải dữ liệu địa hình thực**; log ghi tốc độ khoảng 20 m/s và AGL biến thiên quanh 100 m, có `event=SIMULATED_SYNTHETIC_TERRAIN_ROUTE` để nhận diện là mô phỏng.

`FILEMANAGER_ROOT` là ranh giới bảo mật ứng dụng. Đường dẫn `..`, đường dẫn tuyệt đối và symbolic link bị từ chối; thư mục dữ liệu ứng dụng không được liệt kê. Tệp hệ thống vẫn chịu kiểm soát quyền Unix của user chạy dịch vụ. Không cấu hình root là `/` nếu không thực sự cần thiết.

### Triển khai trên QNX/KR260

Ứng dụng không gọi lệnh Linux như `df`, `stat`, `zip`, không đọc `/proc/mounts` trên QNX và không phụ thuộc systemd. Module giám sát QNX cần có lệnh `pidin`, `top` và procfs QNX (`/proc/vm/stats`, `/proc/<pid>/vmstat`) trong image. Tài khoản dịch vụ cần quyền truy vấn tiến trình QNX phù hợp; nếu thiếu quyền, thông tin RAM hệ thống vẫn có thể hiện nhưng RSS của tiến trình có thể không đọc được. Python/Flask, SQLite, ZIP, TLS và các API filesystem cũng phải có sẵn trong image target. Đây là hướng dẫn porting: cần build và kiểm chứng trên đúng image/BSP KR260 trước khi đưa vào sử dụng; kiểm tra trên Ubuntu không chứng minh ABI hoặc driver QNX tương thích.

#### 1. Kiểm tra image và Python

Đảm bảo BSP/network driver cho KR260 hoạt động, thiết bị có địa chỉ IP và có một mount dữ liệu persistent ghi được. Xác nhận Python target và module ABI ngay trên board:

```sh
uname -a
python3.11 -V
python3.11 -c 'import ssl, sqlite3, zlib, zipfile; print(ssl.OPENSSL_VERSION)'
pidin info
pidin -F "%a %N %U %u %v"
top -b -i 1 -D 1
cat /proc/vm/stats
cat /proc/1/vmstat
```

Đừng cài wheel hoặc thư viện native build cho Ubuntu lên QNX. Cần dùng package Python target được build cho đúng QNX SDP/architecture, hoặc build/cross-compile từ QNX SDP host tools. Tài liệu QNX hiện có Python 3.11 cho SDP 7.1; ghi chú SDP 8.0.3 có Python 3.13. Vì vậy Python 3.11 trên một image SDP 8.0/KR260 có thể là bản tùy biến; phải xác nhận nguồn build, ABI và tương thích package. Đóng gói các dependency của `requirements.txt` (Flask, Werkzeug và dependency gián tiếp) cho đúng target. `gunicorn` trong requirements chỉ dành cho Linux; không dùng trên QNX nếu chưa port và kiểm thử riêng.

Chép mã nguồn (`app.py`, `static/`, `tools/`) và Python packages tương thích vào image/board. Checker giúp báo thiếu tính năng trước khi khởi chạy:

```sh
python3.11 tools/check_qnx_runtime.py
```

Checker cần kết thúc mã 0. Nó kiểm tra module, SQLite, ZIP Deflate, TLS context, loopback socket và filesystem cơ bản; trên QNX nó còn kiểm tra `pidin`, `top` và các file vmstat cần cho monitor. Checker không xác nhận format output của BSP, certificate chain, network từ xa, độ bền ổ đĩa hay tải đồng thời.

#### 2. Chọn thư mục và quyền ghi

Ví dụ dưới đây giả định phân vùng dữ liệu được mount tại `/fs/data`; thay bằng mount point thực tế của image. Không dùng vùng dữ liệu tạm trong RAM để lưu database hoặc file người dùng. Cấp quyền tối thiểu cho user dịch vụ, và bảo đảm filesystem hỗ trợ các thao tác POSIX cần dùng như `chmod`, rename nguyên tử (`os.replace`) và SQLite locking.

```sh
mkdir -p filescope/root filescope/state filescope/tmp
export FILEMANAGER_ROOT=filescope/root
export FILEMANAGER_DB=filescope/state/filemanager.sqlite3
export FILEMANAGER_TMP=filescope/tmp
export FILEMANAGER_MOUNTS=/
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

Thực hiện các ca TC-01 đến TC-37 bên dưới với dữ liệu thử, đặc biệt TC-04/05/06/08/10/12/13/18/26–37. Trên QNX xác nhận riêng giám sát bằng TC-37, các mount đã cấu hình, upload lớn không làm đầy RAM, database tồn tại sau reboot, quyền file đúng với filesystem và HTTPS truy cập được từ máy khách. Kết quả trên Linux chỉ kiểm chứng chức năng chung; chỉ ghi nhận tương thích QNX sau khi các ca này chạy đạt trên chính board/image.

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
| TC-22 | Role `write`/`admin` sửa tệp `.txt`, lưu rồi mở lại | Nội dung UTF-8 lưu đúng; audit ghi nhận `edit_save`; role `read` bị HTTP 403 khi gọi API ghi |
| TC-23 | Sửa tệp nhị phân/định dạng không hỗ trợ, quá giới hạn hoặc đã đổi từ nơi khác | Bị từ chối; vượt giới hạn trả HTTP 413; revision cũ trả HTTP 409 và không ghi đè nội dung mới hơn |
| TC-24 | Thêm nhiều dòng đến cuối vùng nhìn, sau đó Undo/Redo bằng nút và phím tắt | Editor tự cuộn theo caret; undo/redo khôi phục chính xác nội dung và vị trí chọn |
| TC-25 | Đổi quyền bằng các danh sách chọn và bằng ô số bát phân | Các lựa chọn cập nhật đúng ba chữ số; nhập số cập nhật lại các danh sách; quyền tệp khớp giá trị đã chọn |
| TC-26 | Mở tile DTED `.dt2`, bấm lấy độ cao và chọn điểm tọa độ từ log | Phạm vi/độ phân giải hiển thị; NoData được nhận diện; tọa độ log trong tile được phủ và chênh cao tính đúng |
| TC-27 | Đọc CSV/JSON/JSONL/log, lọc ngày/từ khóa, phát lại và xuất CSV | Trường tọa độ/thời gian phổ biến được chuẩn hóa; giới hạn 5.000 bản ghi được báo |
| TC-28 | Mở editor, kéo góc dưới phải theo chiều ngang và dọc | Cửa sổ đổi kích thước, vùng soạn thảo tự co giãn và vẫn cuộn được |
| TC-29 | Phát log có timestamp với nhiều hệ số tốc độ, thay đổi hệ số khi đang phát và tua thanh thời gian | Khoảng cách thời gian phát thay đổi theo hệ số; đổi tốc độ có hiệu lực ngay; tua dừng phát để chọn đúng bản ghi |
| TC-30 | Thêm nhiều log làm lớp phủ, gỡ từng lớp và xóa toàn bộ | Tối đa bốn quỹ đạo phụ có màu phân biệt; đường đi của log đang phát vẫn được nhận biết |
| TC-31 | Xem biểu đồ, nhấn vào các thời điểm và xem thống kê | Biểu đồ cao độ/tốc độ di chuyển con trỏ thời gian; quãng đường, thời lượng, tốc độ và cao độ khớp với log |
| TC-32 | Phân tích AGL với ngưỡng khác nhau | Cao độ địa hình được tra theo lô; AGL và số điểm dưới ngưỡng cập nhật đúng; các điểm cảnh báo được đánh dấu trên bảng/bản đồ |
| TC-33 | Nhập tọa độ trong tile, giữa vùng chồng tile và trong dải trống | Tile chứa tọa độ được liệt kê; danh mục báo đúng cặp tile chồng diện tích và vùng trống trong khung bao |
| TC-34 | Xuất báo cáo HTML và CSV sau phân tích | Báo cáo mở độc lập, gồm bản đồ/biểu đồ/thống kê/điểm thấp; CSV có thêm terrain elevation, AGL và cờ dưới ngưỡng |
| TC-35 | Phân tích địa hình rồi kéo chọn vùng và pan ngang/dọc trên hai biểu đồ | Cao độ bay và DTED dùng cùng trục; vùng chênh AGL hiển thị; biểu đồ tốc độ tách riêng; kéo chọn phóng đúng vùng, pan di chuyển cửa sổ, hai biểu đồ giữ chung thời gian và reset trả về toàn bộ log |
| TC-36 | Dùng chuột hoặc cảm ứng kéo chọn vùng, pan, đổi sang biểu đồ còn lại rồi reset | Khung chọn theo con trỏ mượt; pan ngang/dọc; thời gian đồng bộ giữa hai biểu đồ; nhấn điểm vẫn chọn đúng bản ghi; reset trả toàn bộ trục về mặc định |
| TC-37 | Trên QNX, gọi `/api/system/resources` và `/api/system/processes`; so sánh với `top`/Momentics | RAM khả dụng/tổng và tải từng lõi có số liệu; tiến trình có PID, CPU delta và RSS khi quyền procfs cho phép; làm mới 5 giây; mạng bị ẩn; lệnh tín hiệu tiến trình không được phép |

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
| `FILEMANAGER_MAX_EDIT_BYTES` | `4194304` | Kích thước tối đa mỗi tệp đọc/lưu trong editor văn bản |
| `FILEMANAGER_GEO_ROOT` | `FILEMANAGER_ROOT` | Thư mục tìm `.dt2` và log, bắt buộc nằm trong root quản lý |
| `FILEMANAGER_MAX_GEO_FILE` | `33554432` | Kích thước tối đa của một tile/log dùng trong trang bản đồ và nhật ký |
| `FILEMANAGER_MIN_FREE_SPACE` | `67108864` | Dung lượng phải còn lại sau upload/giải nén |
| `FILEMANAGER_SESSION_IDLE` | `1800` | Thời gian idle tối đa của phiên, đơn vị giây |
| `FILEMANAGER_MOUNTS` | tự dò trên Linux; QNX chỉ dùng root | Danh sách mount points phân cách bằng `:` (QNX nên đặt tường minh) |
| `FILEMANAGER_PROTECTED_PROCESSES` | `core_r,core-r,corer` | Danh sách chuỗi tên process phân cách bằng dấu phẩy; tiến trình khớp sẽ không có thao tác điều khiển |
| `FILEMANAGER_QNX_PIDIN` | `pidin` | Đường dẫn/tên lệnh QNX dùng đọc RAM và thời gian CPU tiến trình |
| `FILEMANAGER_QNX_TOP` | `top` | Đường dẫn/tên lệnh QNX dùng đọc CPU từng lõi và RAM khả dụng |
| `FILEMANAGER_TMP` | thư mục tạm mặc định của Python | Thư mục writable dùng để spool upload và tạo ZIP; trên thiết bị nên đặt nơi có dung lượng phù hợp |

Đặt `FILEMANAGER_MIN_FREE_SPACE=0` nếu muốn tắt phần dung lượng dự phòng. Không nên đặt quá cao trên thiết bị có phân vùng nhỏ; giá trị này vừa tạo cảnh báo trên trang dung lượng vừa chặn upload/giải nén có thể làm dung lượng trống giảm xuống dưới ngưỡng.
