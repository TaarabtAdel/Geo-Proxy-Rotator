GEO PROXY ROTATOR
Extension Manifest V3 để test hiển thị bài viết theo IP proxy và vị trí USA.

CÀI ĐẶT
1. Mở Chrome, vào chrome://extensions
2. Bật Developer mode (góc phải).
3. Bấm Load unpacked.
4. Chọn thư mục chứa file manifest.json này.
5. Ghim icon Geo Proxy Rotator lên thanh công cụ.

CẤU HÌNH
1. Bấm chuột phải icon extension → Options, hoặc mở popup rồi bấm Cài đặt.
2. Bấm "Lấy proxy USA miễn phí". Nút này gộp hai nguồn mặc định:
   - API ProxyScrape (proxy HTTP)
   - https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/us/data.json
     (HTTP và SOCKS của USA)
   Hoặc tự dán proxy, mỗi dòng một proxy:
   ip:port
   ip:port:user:pass
   socks5://ip:port
3. Dán link bài viết, mỗi dòng một URL http/https.
4. Chỉnh thời gian chờ giữa các bài (mặc định 100–120 giây), timeout proxy (mặc định 15 giây) và tuỳ chọn lặp vòng.
5. Bấm "Lưu cấu hình".

CÁCH TEST
1. Nên tắt rotator trước khi bấm lấy proxy mới.
2. Bấm Bắt đầu trên popup.
3. Chrome mở một tab, thử https://api.ipify.org. Proxy lỗi hoặc quá timeout sẽ bị bỏ qua.
4. Proxy sống: extension chọn ngẫu nhiên một thành phố USA, giả lập GPS + múi giờ, rồi mở lần lượt các bài.
5. Popup hiện proxy (x/tổng), vị trí, bài đang mở, đếm ngược và số proxy lỗi.
6. Bấm Dừng để gỡ debugger, xoá proxy và trả trình duyệt về mạng bình thường.
7. Trên trang bài, kiểm tra vị trí bằng một trang kiểu https://browserleaks.com/geo (thêm URL đó vào danh sách bài nếu muốn).

LƯU Ý
- Proxy miễn phí thường chậm hoặc chết. Hãy chuẩn bị nhiều proxy.
- Chrome hiện thanh "extension is debugging this browser" khi đang giả lập vị trí. Đó là cơ chế debugger của extension, không phải virus.
- Đừng dùng extension này với tài khoản hoặc dữ liệu nhạy cảm.
