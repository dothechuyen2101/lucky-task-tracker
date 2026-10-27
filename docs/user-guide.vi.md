# Task Tracker — Hướng dẫn sử dụng

[English](user-guide.en.md) · **Tiếng Việt**

Hướng dẫn này dành cho người dùng tracker: người giao việc trên Discord và người nhận việc. Phần cài đặt kỹ
thuật (Supabase, Vercel, biến môi trường) nằm trong [README](../README.md).

Tên nút và mục trong app giữ nguyên tiếng Anh, **in đậm**, để bạn tìm đúng trên màn hình.

---

## 1. Tóm tắt trong một phút

1. Trong kênh Discord mà tracker theo dõi, bạn **tag bot của mình**, **@-nhắc người nhận**, và ghi **làm gì**,
   **khi nào xong**:

   > `@YourBot @minh làm lại thumbnail, deadline is 24 hours`

2. Tin nhắn đó thành một **thẻ** trên board: có tên Minh, có deadline và **đồng hồ đếm ngược** chạy trực tiếp.
3. Khi gần đến hạn, bot **DM cho Minh và cho bạn**, và tiếp tục nhắc cho đến khi việc xong.
4. Bot trả lời mọi lần tag để không ai phải đoán bot đã đọc chưa: **✅** đã tạo thẻ, **👀** đã đọc nhưng
   không tạo thẻ, hoặc **DM** khi reaction sẽ không ai thấy.

Bạn cũng có thể **nhắn riêng (DM) cho bot** y như vậy mà không cần tag. Ai được giao việc cũng xem được toàn bộ
việc của mình ở một chỗ: trang **My tasks**.

Bot chỉ đọc những tin tag nó, hoặc tin nhắn riêng gửi cho chính nó. Mọi tin khác trong kênh đều bị bỏ qua.

---

## 2. Cài đặt (làm một lần, khoảng 10 phút)

Mọi bước dưới đây làm trong trang **Settings**.

### 2.1 Đăng nhập

Mở tracker và bấm **Sign in with Discord**. Tracker chỉ biết bạn là ai và bạn ở những server nào. Đăng nhập
không cho phép đọc bất kỳ tin nhắn nào của bạn.

### 2.2 Tạo bot riêng — mục *Your Discord bot*

Mỗi người dùng bot của riêng mình, không dùng chung.

1. Tạo một application trên Discord developer portal (**New application**). Đặt tên gì cũng được.
2. Vào tab **Bot**, bấm **Reset Token** và sao chép token. Discord chỉ hiện token này một lần.
3. Cũng ở tab đó, bật **Message Content Intent**. Không bật thì mọi task đến đều trống chữ.
   Bật luôn **Server Members Intent**: khi đó ô "Given to" trên board liệt kê mọi người trong server. Không bật
   thì vẫn tìm được bất kỳ ai bằng cách gõ tên.
4. Dán token vào ô và bấm **Connect bot**.

### 2.3 Kết nối Claude — mục *Your Claude*

Claude là phần đọc từng tin được tag và biến nó thành thẻ. Chọn một trong hai cách:

- **Dùng gói Claude bạn đang trả (không tốn thêm).**
  - Windows: tải công cụ hỗ trợ về, đăng nhập Claude trong cửa sổ trình duyệt nó mở ra, quay lại trang,
    bấm **Ctrl+V** vào ô rồi bấm **Connect Claude**.
  - Mac: chép dòng lệnh hiển thị trên trang vào Terminal.
  - Với gói subscription, chỉ dùng được **Claude Haiku 4.5**.
- **Dùng API key** (`sk-ant-api…`). Dán vào cùng ô đó. Loại này tính tiền theo lượng dùng và dùng được mọi
  model.

Chưa kết nối Claude thì chưa có tin nào được tạo thẻ. Tin được tag không mất: chúng chờ và được xử lý ngay
khi Claude được kết nối.

### 2.4 Mời bot vào server — mục *Your servers*

1. Bấm **Refresh my servers**.
2. Bấm **Invite bot** cạnh mỗi server có giao việc. Bạn cần quyền *Manage Server* ở server đó; nếu không, nhờ
   admin mời (**Ask an admin**).
3. Bot chỉ xin quyền xem và đọc kênh, gửi tin và thả reaction, không gì khác.
4. Nếu bạn đã mời bot từ lâu bằng link cũ, hãy mời lại. Thiếu quyền *Add Reactions* thì bot không thả được
   ✅ / 👀 lên tin nhắn.

**Một server không có trong danh sách** — server bạn vừa vào, hoặc vừa được chuyển quyền owner:

- Danh sách được đọc bằng lượt đăng nhập Discord của bạn, mà Discord chỉ cho trang này dùng trong khoảng một
  tuần. Khi đã hết hạn, mục này báo bằng khung đỏ và **Refresh my servers** không lấy thêm được gì: bấm **Sign in
  again**, rồi **Refresh my servers**.
- Hoặc bấm **Invite your bot from Discord's own list** bên dưới danh sách: Discord hiện mọi server bạn sở hữu hoặc
  quản lý ngay lúc đó. Nếu vẫn không thấy server, xem tên ở đầu trang của Discord — đó là tài khoản mà *trình duyệt*
  đang đăng nhập, có thể khác với tài khoản trong app Discord.
- Mời bằng nút trên trang này, không dùng link người khác dán: link tự tạo có thể là của bot khác, hoặc xin sai
  quyền.

### 2.5 Chọn kênh theo dõi — mục *Channels to watch*

1. Bấm **Refresh from Discord**.
2. Bấm vào từng kênh muốn theo dõi, hoặc **Select all** cho cả server.
3. Việc theo dõi bắt đầu **từ lúc bật**. Để lấy các tag viết trước đó, bấm **Backfill past tasks**. Chạy lại
   bao nhiêu lần cũng không tạo thẻ trùng.
4. **Server và kênh mới được tự phát hiện** trong vòng 5 phút và được theo dõi từ lúc chúng xuất hiện — tag viết
   ở đó trước khi được phát hiện vẫn được đọc, và người tag được báo qua DM. Kênh nào không muốn thì tắt đi;
   đã tắt thì giữ nguyên.
5. Thread, bài trong forum và khung chat của kênh voice **không** được đọc. Hãy tag bot trong kênh thường.

### 2.6 Nơi nhận nhắc việc và múi giờ

- **Where reminders arrive:** mặc định bot DM cho bạn. Nếu cài đặt riêng tư Discord của bạn chặn DM từ bot,
  hãy chọn một kênh để nhận thay.
- **Your time zone:** được lấy tự động từ trình duyệt lần đầu bạn mở board, và đổi được ở đây. Nó quyết định
  "Tuesday", "tonight" và "5pm" nghĩa là lúc nào, và mọi giờ hiển thị trên board.

### 2.7 Kênh dự án (không bắt buộc) — mục *Project channels*

Giúp dọn các dự án đã xong khỏi danh sách kênh trong server Discord. Kênh của từng server được xếp theo chỗ
chúng nằm: **Active projects** (đang làm), **Done projects** (đã xong), hoặc chưa thuộc nhóm nào.

- **Done →** chuyển kênh vào category "Done projects"; **← Active** chuyển ngược lại.
- Hai category được tạo ở lần đầu bạn dùng. Mỗi category chứa tối đa 50 kênh; khi "Done projects" đầy, bot tạo
  "Done projects 2".
- Kênh giữ nguyên quyền riêng của nó dù chuyển đi đâu, và vẫn được theo dõi như cũ.
- Không kênh nào tự chuyển.
- **Bot cần quyền Manage Channels** cho việc này. Link mời thông thường không xin quyền đó, nên hãy bấm
  **Allow moving channels** ở server đó một lần để mời lại bot.

---

## 3. Giao việc trên Discord

**Mẫu câu:** `@YourBot @người_nhận việc cần làm, hạn chót`

| Bạn viết | Kết quả |
|---|---|
| `@YourBot @minh redo the thumbnail, deadline is 24 hours` | Task cho Minh, hạn 24 giờ sau lúc gửi tin |
| `@YourBot @minh cut the teaser, 36 hours` | Hạn 36 giờ sau lúc gửi |
| `@YourBot @lan send the invoice by Tuesday` | Hạn 17:00 thứ Ba sắp tới |
| `@YourBot @lan update the pricing page by Oct 3` | Hạn 17:00 ngày 3/10 |
| `@YourBot @rea @cenri send the cost breakdown, deadline 48 hours` | Một thẻ cho Rea và một thẻ cho Cenri, cùng nội dung và hạn chót |
| `@YourBot fix the login page` | Task **No assignee** và **No deadline**, bổ sung trên board |

**Cần biết**

- **Chọn tên từ danh sách @ của Discord** để tên chuyển màu xanh. Gõ tên bằng chữ thường thì không phải là
  mention.
- **Tag bot hoặc tag role mang tên bot** đều được tính như nhau. Discord hiện cả hai trong danh sách @.
- **Mọi người được @-nhắc đều nhận việc — mỗi người một thẻ riêng**, có nhắc việc, nút xong và điểm riêng.
  Thẻ ghi những ai cũng nhận việc này ("Also given to"). Không cần từng giao việc cho họ trước đó. Trả lời vào
  tin nhắn gốc ("push it to Friday") thì đổi mọi thẻ mà tin đó tạo ra.
- **Chỉ muốn báo cho ai đó biết? Viết "cc" trước tên họ.** Ai được tag sau **cc**, **cc:**, **/cc** hoặc **fyi** —
  "@jfabbs put the CTAs in one Excel, cc @umer" — không có thẻ, không bị nhắc; task ghi họ ở mục **CC**. Ai được tag
  ở chỗ khác trong tin vẫn có thẻ. Nếu một thẻ lỡ giao cho người chỉ được nhắc tên, mở thẻ đó và bấm **Take … off
  this** (chủ board, hoặc người đã nhờ việc): thẻ của họ được đóng, không tính điểm cộng hay trừ, và họ nhận DM báo
  như vậy. Đừng bảo họ reply "done" — làm vậy sẽ ghi một lần duyệt cho việc không phải của họ.
- **Không tin nào bị bỏ.** Tag thiếu người nhận hoặc thiếu hạn vẫn thành thẻ, ghi rõ **No assignee** hoặc
  **No deadline**.
- **Hạn chót tính từ lúc gửi tin, theo múi giờ của bạn.**
  - "Tuesday", "by Tuesday" và "**next Tuesday**" đều là thứ Ba gần nhất phía trước. Nói vào đúng thứ Ba
    thì là thứ Ba tuần sau.
  - "today" và "by EOD" là 17:00 hôm nay. "tonight" là 21:00. "tomorrow" là 17:00 ngày mai.
  - Ngày không kèm giờ nghĩa là 17:00 ngày đó.
  - "ASAP", "soon", "the Monday meeting" hay "shows up in 5 minutes" không được hiểu là hạn chót.
  - Viết tiếng Việt cũng được, vì Claude đọc hiểu (ví dụ "hạn 24 giờ", "trước thứ Ba"). Các mẫu tiếng Anh
    trong bảng là chắc chắn nhất: tracker tự đọc được chúng, kể cả khi Claude bỏ sót hạn chót.
- **Tag đến theo đường khác cũng được tính:**
  - tin được **sửa** để thêm `@YourBot`;
  - tin **chuyển tiếp (forward)** có tag bot;
  - tin do **tích hợp** (bot hoặc webhook, ví dụ từ Trello) đăng có tag bot của bạn.
- **Người khác tag bot của bạn và @-nhắc bạn:** đó là task **giao cho bạn** ("X asked you").
- **Người trong team tag bot của bạn để giao việc cho người khác (hoặc cho chính họ):** nếu họ đã đăng nhập
  tracker một lần, việc được lưu **trên board của bạn**, ghi "X asked". Bot của bạn nhắc việc, và bạn duyệt khi
  việc xong. Họ thấy mọi việc mình đã nhờ — nhờ bạn, hoặc nhờ người khác qua bot của bạn — ở mục **I asked
  for** trên board của họ, chỉ xem.
- **Người chưa từng đăng nhập tag bot của bạn để giao việc cho người thứ ba:** không lưu gì cả. Bot thả 👀 và
  trả lời rằng nó chỉ nhận việc từ team của bạn, kèm cách tham gia (đăng nhập một lần).

### 3.1 Giao việc bằng tin nhắn riêng (DM) cho bot

Bạn có thể giao việc trong tin nhắn riêng với **bot của mình** thay vì trong kênh. Mọi thứ chạy giống trong kênh,
và bot trả lời bạn ngay trong DM.

1. Mở DM với bot: Settings → *Direct messages to your bot* → **Open your bot's profile** → **Message**. Bạn phải
   ở chung một server với bot.
2. Viết việc như trong kênh, **không cần tag bot**:

   > `@minh làm lại thumbnail, 36 hours`

3. Trong DM, danh sách @ của Discord không gợi ý người khác, nên **gõ tên bằng chữ** (`@minh`).
   - Nếu tên **khớp chính xác** tên của đúng một người bạn từng giao việc (hoặc có ghi chú), việc được giao cho
     họ, và bot trả lời việc đã giao cho ai, hạn lúc nào.
   - Nếu không — hai người trùng tên, tên chỉ gần giống, hoặc người chỉ tìm thấy trong một server của bạn —
     **chưa ai được giao**. Bot liệt kê những người có thể là họ: "Who is "bob"? 1. Bob Tran (@bob_t) · Server A
     2. @bobby · Server B". Reply tin đó bằng số thứ tự, hoặc chọn trên board. Trước khi bạn chọn, không ai nhận
     được tin gì.
4. Người được giao nhận **DM từ bot của bạn** báo bạn vừa giao việc cho họ. (Việc giao trong kênh thì không cần,
   vì họ đã được @-nhắc.)

Trong cùng DM đó bạn còn có thể:

- **reply** vào tin của bot về một việc: `done`, `dismiss`, `deadline friday 5pm`, `6 more hours` hoặc `remind me daily`;
- hỏi `what's open?` để xem danh sách việc.

**Bot không làm được:** đọc DM giữa bạn và Minh. Bot chỉ thấy tin nhắn gửi **cho chính bot**.

---

## 4. Bot trả lời một lần tag thế nào

| Bạn thấy | Ý nghĩa |
|---|---|
| **✅** trên tin nhắn | Đã tạo thẻ. Tag lại đúng yêu cầu đó (cùng lời, cùng người) khi task đầu còn mở cũng nhận ✅, và không có thẻ thứ hai. |
| **👀** trên tin nhắn | Đã đọc và cố ý không tạo thẻ: lời cảm ơn, tán gẫu, câu hỏi cho bot, hoặc lệnh bot không làm được. Tin nằm trong danh sách **Not filed** trên board, bấm một lần là thành thẻ. Câu hỏi và lệnh thất bại còn nhận một câu trả lời ngắn, không ping ai. |
| **Một DM từ bot** | Gửi cho người đã tag, khi reaction sẽ không ai thấy. Trường hợp đó gồm tag được đọc **muộn** (hơn 10 phút sau khi viết — thêm vào bằng cách sửa tin, Backfill tìm ra, hoặc tracker từng ngừng chạy) và tag trong kênh bot **không được thả reaction**. DM liệt kê từng tag đã được xử lý ra sao và dặn không cần tag lại. Mỗi người tối đa một DM mỗi 10 phút. Nếu không DM được người đó, bạn nhận thay. |
| **Không có gì** sau vài phút | Bot không thấy tin đó. Kênh chưa được theo dõi, bot không có trong kênh, hoặc tên không phải mention thật. |

**Đừng tag lại cùng một việc.** Không chắc thì xem trên board.

---

## 5. Sửa task ngay trên Discord

**Reply** vào tin đã tạo ra task, và tag bot:

| Reply | Kết quả |
|---|---|
| `@YourBot done` | Việc của chính bạn: đánh dấu xong. Việc bạn giao cho người khác: **duyệt** (approve) — đúng hạn hay trễ hạn tuỳ thực tế (xem 6.6) |
| `@YourBot ignore that` / `dismiss` | Bỏ qua (dismiss) |
| `@YourBot deadline friday 5pm` | Đổi hạn chót, theo múi giờ của bạn. Hạn này tính là đặt tay, nên máy sẽ không tự đổi nữa. |
| `@YourBot give her 6 more hours` / `2 extra days` / `push it back a day` | **Gia hạn:** hạn chót lùi thêm đúng chừng đó so với hạn hiện tại (tính từ bây giờ nếu hạn đã qua lâu). Hạn cũ không bị tính là trễ. |
| `@YourBot remind me daily` / `every 3 hours` | Đổi tần suất nhắc |
| `@YourBot also do the footer` | Thêm việc mới, nên thành một task riêng |

Khi người được giao báo một việc đã xong, bot DM cho bạn **kèm bằng chứng và link thẳng tới task**. **Reply
vào DM đó**:

| Reply | Kết quả |
|---|---|
| `approve` | Duyệt — đúng hạn hay trễ hạn tuỳ thực tế. Gõ `approve late` / `approve on time` để tự chọn. |
| `extend 2 days` | Gia hạn, không bị trừ điểm: task mở lại với hạn mới. |
| `disapprove: thiếu phần footer` | Không duyệt: −1, và task mở lại với khoảng thời gian họ còn lại. **Bắt buộc ghi lý do** — chỉ gõ `disapprove` thì bot sẽ hỏi lý do. |

Lệnh làm được thì nhận **✅** và một câu trả lời ngắn. Lệnh không làm được thì nhận **👀**, lý do, và một dòng
trong **Not filed**.

---

## 6. Board

### 6.1 Phần đầu trang

- **Team** — ai đang làm việc gì, cập nhật tức thì (xem 6.7).
- **My tasks** — mọi việc được giao cho bạn, từ tất cả mọi người (xem mục 8).
- **Các con số:** Open (đang mở) · Overdue (quá hạn) · Due today (hạn hôm nay) · Need a deadline (thiếu hạn) ·
  Need an assignee (thiếu người nhận) · On you (việc của bạn) · To review (chờ bạn duyệt) · Messages read ·
  Channels watched.
- **Ô tìm kiếm:** tìm theo tiêu đề, nội dung tin nhắn và tên người.
- **Bộ lọc:**
  - **All** — mọi task đang mở.
  - **Assigned to me** — việc của bạn.
  - **I asked for** — việc bạn giao, kể cả việc bạn nhờ người khác qua bot *của họ* (chỉ xem; việc nằm trên
    board của họ).
  - **To review** — việc người làm báo đã xong kèm bằng chứng, đang chờ bạn duyệt (xem 6.6).
  - **Done & dismissed** — việc đã xong, việc không đạt (failed) và việc đã dismiss; tải 300 task đóng gần nhất.
- **Sắp xếp và lọc** (dưới các bộ lọc): sắp xếp theo **priority**, **deadline** hoặc **ngày tạo**, tăng hoặc
  giảm; chỉ hiện một số **priority**; chỉ hiện các hạn chót **trong khoảng hai ngày**. Dùng được cùng mọi bộ lọc ở
  trên và ô tìm kiếm, và giữ nguyên khi bạn đổi bộ lọc hay tải lại trang. **Clear** bỏ hết.
- **Thông báo:**
  - **Not tracking yet** — chưa cài đặt xong.
  - **The bot cannot react everywhere** — nêu tên những kênh bot không được thả ✅ / 👀, kèm nút
    **Invite again**.

### 6.2 Dải thẻ và thẻ đang chọn

- Các thẻ trượt trái phải. Vuốt, cuộn, bấm mũi tên, hoặc dùng phím ← / →.
- Thẻ ở giữa được hiện đầy đủ bên cạnh dải thẻ (trên điện thoại thì ở bên dưới).
- Mỗi thẻ có:
  - **đồng hồ** — màu hồng **Overdue** khi đã quá hạn, màu vàng khi hạn là hôm nay;
  - **tên việc**;
  - **người nhận**;
  - nút **All tasks**, mở mọi việc người đó được giao.

### 6.3 Sửa task (trong khung chi tiết)

| Phần | Làm được gì |
|---|---|
| **Tiêu đề** | Bấm để sửa. Enter lưu, Esc huỷ. |
| **Description** | Ngay dưới tiêu đề: việc cần làm là gì — các bước, link, thế nào là xong. Ô tự giãn theo nội dung nên mô tả dài vẫn đọc trọn; kéo góc ô để làm cao thêm. Lưu khi bạn rời khỏi ô, và được gửi kèm mọi lần nhắc. Người nhận việc cũng thấy nó trên thẻ của họ. |
| **Deadline** | Lưu khi bạn **rời khỏi ô** hoặc nhấn Enter; Esc để hoàn tác. Giờ tính theo múi giờ của bạn. Nút **Use <ngày>** hiện ra khi tin nhắn nêu một thời điểm khác. Các nút **+1h / +6h / +1 day** bên dưới gia hạn chỉ với một lần bấm. Chỉ hạn cuối cùng được tính: dời hạn — trước hay sau khi trễ — đều xoá lần trễ của hạn cũ. |
| **Priority** | High, Medium hoặc Low. Mặc định Medium, trừ khi tin nhắn nói "urgent"/"gấp" hay "low priority", hoặc bạn đổi. High và Low hiện trên thẻ. |
| **Tần suất nhắc** | Từ 15 phút đến hằng tuần, hoặc **No reminder**. Bị khoá cho đến khi task có hạn chót. |
| **Reminds / Next reminder / Sent so far** | Lần nhắc tới gửi cho ai, lúc nào, và đã gửi bao nhiêu lần. |
| **Nhắc người nhận** | Một dòng cho biết việc nhắc họ đang thế nào (đã nhắc 2 lần, đã tắt, DM bị từ chối, đã hết số lần), kèm **Stop reminding <tên>** / **Remind <tên> again**. |
| **Remind now** | Cạnh **Stop reminding**: DM cho người đang được giao task **ngay lập tức**, không chờ lịch nhắc. Gõ lời nhắn vào ô phía trên thì họ nhận đúng nội dung đó (kèm một dòng ghi tên task); để trống thì họ nhận tin nhắc mặc định. Chỉ gửi cho người được giao, được tính vào **Sent so far**, và ghi vào **Activity** kèm người gửi; dưới nút hiện **Last reminded by hand by … · lúc nào**. Bị làm mờ khi task chưa có ai được giao. Mỗi task tối đa 2 phút một lần. |
| **Given to** | Chọn hoặc đổi người nhận: không ai, chính bạn, người bạn từng giao việc, hoặc **bất kỳ ai trong server** — gõ tên để tìm. Người mới được nhắc lại từ đầu. Nếu tin nhắn tag cả người khác, **Also given to** mở thẻ của họ. |
| **Stage** | Started → In progress → Testing → Completed → Closed. Bấm vào mốc hiện tại để lùi một bước. Với việc của chính bạn, Completed hoặc Closed là xong. Với việc giao cho người khác, chỉ **duyệt** (6.6) mới đưa tới Completed — bấm vào đó sẽ mở khung duyệt. Việc đã báo xong nằm chờ ở Testing. |
| **The message** | Tin Discord gốc, kèm **Open in Discord**. |
| **Màu (Colour)** | Màu thẻ. |
| **Mark done / Approve or disapprove…, Reopen, Dismiss / Restore, Delete** | Việc của chính bạn: **Mark done**. Việc giao cho người khác: **Approve or disapprove…** mở khung duyệt (6.6). Việc đã duyệt hoặc đã failed là chốt. **Dismiss** giữ thẻ trong "Done & dismissed". **Delete** không hoàn tác được. |
| **Proof and reviews** | Mọi bằng chứng người làm gửi — chữ, link, ảnh, file — và mọi lần duyệt, theo thứ tự thời gian. Task mở lại vẫn giữ hết. |

**Thêm task bằng tay:** dùng ô dưới dải thẻ, chọn priority bên cạnh.

### 6.4 Not filed

Danh sách gập bên dưới dải thẻ chứa mọi tin bot đã đọc mà không tạo thẻ.

- **Make it a task** (hoặc **File it anyway** với tin trùng) biến một dòng thành thẻ.
- **Not a task** đồng ý với bot và bỏ dòng đó khỏi danh sách. **None of these are tasks** làm vậy cho mọi dòng
  đang hiện.
- Không dòng nào tự biến mất. **Show older** và ô tìm kiếm tìm được mọi dòng.

### 6.5 Trang một người

Bấm vào tên để xem việc đang mở và đã xong của người đó, và số lần việc **không được duyệt (Disapproved)**.
**Điểm (Score)** của họ (tháng này và tổng) cùng các bút toán gần nhất chỉ hiện cho **Lucky35** và cho chính người
đó — kèm link tới mọi bút toán (6.6.2). **Send a note** gửi họ một DM từ bot
của bạn, nên hãy xưng tên. Ghi chú và điểm 1–5 do bạn chấm được gập ở cuối — điểm chấm tay là của riêng bạn,
điểm trễ hạn không bao giờ thay đổi nó.

### 6.6 Duyệt việc đã xong

Việc giao cho người khác không bao giờ tự xong. Khi họ báo xong — **luôn kèm bằng chứng**: vài dòng mô tả, link,
ảnh hoặc file — việc đó chờ **bạn duyệt**:

- **ai duyệt:** người tạo task. Nếu một teammate giao việc qua bot của bạn thì là teammate đó; bạn, với tư cách
  chủ board, cũng luôn duyệt được;
- thẻ ghi **Finished by <tên> · to review**, nằm ở **Testing**, và bộ lọc cùng con số **To review** đếm nó.
  Chưa được duyệt thì chưa Completed;
- bot DM cho người duyệt kèm bằng chứng và link thẳng tới task; bằng chứng nằm trong task, ở mục **Activity**;
- trong khung chi tiết, chọn một trong bốn:

| Lựa chọn | Nghĩa là | Điểm |
|---|---|---|
| **Approve — on time** | Xong trước hạn | Tính vào **+0.5 cho mỗi 5 việc** |
| **Approve — late** | Xong sau hạn | **−1** |
| **Disapprove…** | Không đạt | **−1**, và task **mở lại**: về In progress với hạn mới (điền sẵn, sửa được) để họ làm tiếp. **Bắt buộc ghi chú** điều sai hoặc còn thiếu; ghi chú được lưu cùng điểm −1 |
| **Extend deadline…** | Cho thêm thời gian | **Không trừ điểm**; về lại In progress với hạn mới |

- tool đánh dấu lựa chọn duyệt khớp với thực tế là **suggested** (so lúc họ báo xong với hạn chót); bạn quyết
  định;
- điểm thay đổi ngay khi bạn chọn — được ghi vĩnh viễn vào lịch sử điểm của họ (6.6.2) — và người làm nhận DM về
  quyết định của bạn cùng ghi chú (nếu có);
- cho đến khi bạn quyết, người duyệt được nhắc **mỗi ngày một lần**. Không có gì tự được duyệt.

**Đồng hồ dừng trong lúc chờ duyệt:** duyệt chậm không bao giờ làm họ trễ hạn. Ô hạn mới khi Reopen hay Extend
bắt đầu từ khoảng thời gian họ còn lại lúc báo xong, tính từ bây giờ.

Bạn cũng có thể tự đóng việc đã giao mà không cần họ báo: bấm **Approve or disapprove…** trên task đang mở.

**Bấm nhầm?** Quyết định duyệt mới nhất của một task có nút **Undo this verdict** trong mục **Activity** — miễn là
chưa có gì xảy ra sau đó. Task trở về đúng như trước, quyết định vẫn được giữ lại với ghi chú *taken back*, điểm
của nó được **bút toán sửa (correction)** bù lại trong lịch sử điểm, và người làm được báo. Trên Discord bạn có thể reply `disapprove: điều còn thiếu` vào DM của bot; task
cũng được mở lại như vậy.

**Đúng về task, sai về điểm?** Với một quyết định đã trừ −1, nút **Correct the −1…** trong mục **Activity** của nó
thêm một bút toán sửa +1 kèm ghi chú của bạn, task giữ nguyên. Lucky35 làm được với mọi quyết định, người đã ra
quyết định đó cũng làm được.

**Tiến độ là của người làm.** Với việc bạn giao cho người khác, thanh stage là của họ: họ tự đặt **Not started /
Started / In progress** (và lùi lại), còn **Testing** là khi họ báo xong. Bạn chỉ duyệt; Completed là khi bạn chấp
nhận. Nếu họ lỡ báo xong, họ có thể bấm **Take my report back** trước khi bạn duyệt.

### 6.6.1 Activity — những gì đã xảy ra trên task

Mỗi task có mục **Activity**, mới nhất ở trên, kèm dòng **Latest** — việc gần nhất một người đã làm:

- ai tạo task và tạo ở đâu, mọi thay đổi — stage, deadline (từ → đến), người làm, priority — và **ai** đã đổi;
- mọi lần báo xong kèm bằng chứng, mọi quyết định duyệt (kèm điểm, và những quyết định đã hoàn tác);
- mọi tin nhắc bot đã gửi cho người làm — "reminded Rea — 3 times since …" — và những tin **không** gửi tới được;
- mọi lần nhắc thủ công bằng **Remind now** — ai gửi, và lời nhắn của họ;
- những gì mọi người đã trả lời bot về task này.

Muốn ping người làm ngay, dùng **Remind now** ở phần nhắc việc (xem bảng ở 6.3).

### 6.6.2 Scores — lịch sử điểm

Bấm **Scores** ở đầu trang (`/scores`). Mỗi lần ai đó được cộng hay bị trừ điểm là một **bút toán (entry)**, lưu
vĩnh viễn:

- **ai**, **bao nhiêu** (−1 hoặc +0.5), **vì sao** — duyệt trễ hạn, không duyệt, hoặc 5 việc được duyệt đúng hạn —
  **task nào** (với +0.5 là cả 5 task), **khi nào**, và **ai quyết định**; bút toán không duyệt có kèm ghi chú;
- chọn **Day** (ngày), **Week** (tuần, thứ Hai đến Chủ nhật) hoặc **Month** (tháng), lùi/tiến bằng **‹ ›**; giờ
  theo múi giờ của bạn. Với mỗi người: số điểm **trừ** và **cộng** trong khoảng đó, tổng của khoảng đó, và **điểm
  tính đến hết khoảng đó**, các bút toán liệt kê bên dưới. Điểm luôn là tổng các bút toán;
- **bấm vào số điểm trừ** (hoặc điểm cộng) để chỉ xem các bút toán tạo nên con số đó. Mỗi điểm trừ ghi sẵn, không
  cần bấm thêm, vì sao bị trừ: hạn chót và lúc báo xong ("due 10 Oct · reported done 12 Oct · 2 days late"), ghi
  chú của người duyệt khi không duyệt, và **Open task**. Trên trang của một người, ô **Minus** và **Plus** cũng
  làm như vậy; **Show everything** để xem lại tất cả;
- **mở một bút toán** để xem lý do, ghi chú, ai quyết định và lúc nào, task (**Open task**) và **bằng chứng**;
- **bút toán không bao giờ bị sửa hay xoá** — không ai làm được — và vẫn còn dù task đã bị xoá. Sai thì sửa bằng
  **bút toán sửa (correction)**: mở bút toán, bấm **Correct…**, ghi lý do (bắt buộc). Một bút toán ngược dấu được
  thêm bên cạnh — ví dụ +1, "correction, disapproved by mistake" — và cả hai cùng được giữ. Undo một quyết định,
  hoặc dismiss task, tự thêm bút toán sửa (restore task thì tính lại). Nếu một trong 5 task của một lần +0.5 không
  còn được tính, +0.5 đó bị trừ lại và 4 task còn lại được tính cho lần +0.5 kế tiếp;
- bút toán tính vào khoảng thời gian nó được quyết định — bút toán sửa tính vào lúc nó được thêm, nên một tháng đã
  qua không bao giờ thay đổi.

**Ai xem được gì:** mỗi người chỉ thấy lịch sử của chính mình. **Lucky35** thấy của mọi người, chọn một người (hoặc
**Everyone**), và **xuất CSV** đúng những gì đang hiện — **History CSV** (mỗi bút toán một dòng, có link task) và
**Totals CSV** (mỗi người một dòng) — để xét tăng lương và thưởng. Link tới lịch sử của người khác không hiện gì
với bất kỳ ai ngoài Lucky35. Ai được thêm bút toán sửa: Lucky35, và người đã ra quyết định đó.

### 6.7 Team — ai đang làm việc gì

Bấm **Team** ở đầu trang. Mỗi người bạn giao việc có một khung:

- **việc đang làm** — task ở In progress hoặc Testing, đã ở đó bao lâu, và đồng hồ đếm ngược;
- **Up next** — việc đang mở nhưng chưa bắt đầu;
- **việc chờ bạn duyệt** — kèm nút **Review** mở bộ lọc To review;
- **điểm (Score)**, của **tháng này** (Month) và **tổng** (All) — chỉ hiện cho Lucky35; xem bên dưới.

Người không có việc nào đang mở hiện là **Free** (rảnh). Trang này cập nhật **tức thì**: khi ai đó bấm Start
hay Done, hoặc một hạn chót bị trễ, trang đổi trong vòng một giây, không cần Refresh. Nhãn ở đầu trang ghi
**Live**; nếu ghi **Not live**, hãy bấm Refresh.

**Cách tính điểm** — điểm là tổng lịch sử điểm của mỗi người (6.6.2), đến từ từng lần duyệt (6.6):

- **−1** cho việc **được duyệt trễ hạn**, và cho việc **không được duyệt** (task mở lại).
- **+0.5** cho mỗi **5** việc **được duyệt đúng hạn**, tính cộng dồn — không cần liên tiếp.
- **Gia hạn** khi duyệt không bị trừ điểm.
- Hạn chót trôi qua **không** tự trừ điểm — chỉ lần duyệt mới tính. Việc quá hạn vẫn hiện màu hồng và vẫn được
  nhắc; nếu họ không bao giờ báo, bạn có thể Disapprove.
- Các lần trễ hạn được ghi trước khi có duyệt (7/10/2026) vẫn tính −1 mỗi lần.
- Mỗi người được tính trên thẻ của riêng mình, nên khi một tin nhắn giao việc cho nhiều người, mỗi người được
  duyệt riêng.
- **Tháng này** tính các lần duyệt trong tháng, theo múi giờ của bạn; **tổng** tính tất cả. Monthly summary hiện
  điểm từng người của bất kỳ tháng nào.
- Dismiss một task thì điểm của nó được trả lại bằng một bút toán sửa. Sai sót khác thì sửa trong **Scores**.
- Chỉ Lucky35 thấy điểm của người khác ở đây; ai cũng thấy điểm của mình trong **Scores**.

**Link:** thanh địa chỉ đi theo thẻ đang chọn, nên sao chép link sẽ mở đúng thẻ đó. Mỗi DM nhắc việc có link
thẳng tới thẻ, và sau khi đăng nhập bạn vào đúng thẻ đó.

### 6.8 Monthly summary — tổng kết tháng

Bấm **Monthly** ở đầu trang. Trang này liệt kê mọi việc đã **xong** trong một tháng — việc của bạn (kể cả việc
người khác giao cho bạn) và việc của từng người bạn đã giao — kèm ngày hoàn thành.

- **‹ ›** lùi hoặc tới một tháng; **This month** quay về tháng này. Xem được mọi tháng đã qua, và link tới
  một tháng (`/summary?month=2026-09`) mở đúng tháng đó.
- Các con số: **Finished** (đã xong), **On time** (đúng hạn), **Late** (xong sau hạn chót), **Added** (việc mới
  trong tháng) và **Still open** (trong số đó, còn bao nhiêu chưa xong).
- Một việc được tính vào tháng nó được đánh dấu xong, theo múi giờ của bạn. Việc người làm đã báo xong được
  tính ngay, và ghi **waiting for your review** cho đến khi bạn duyệt.
- Với Lucky35, mỗi người có **điểm của tháng đó** cạnh tên; bấm vào sẽ mở lịch sử điểm của họ trong tháng đó.
- **Copy as text** sao chép danh sách, sẵn để dán vào Discord.
- Bấm vào tên việc để mở thẻ đó trên board.

### 6.9 Developers — ai đang làm gì, cập nhật tay

Bấm **Developers** ở đầu trang. Mỗi developer một dòng: **đang làm gì** và **trạng thái** — Working, Blocked,
In review, Idle hoặc Off. Dùng cho việc nằm ngoài tracker (ví dụ trong ClickUp), cập nhật tay cho đến khi nối
ClickUp.

- **Thêm developer** bằng tên, hoặc chọn từ server.
- Đổi trạng thái bằng menu; gõ việc đang làm rồi nhấn Enter (hoặc bấm ra ngoài) để lưu.
- Mỗi dòng ghi **ai sửa lần cuối, và lúc nào**.
- **Who keeps this list:** chọn một người (ví dụ Naukhaiz) ở dưới danh sách. Người đó đăng nhập tracker bằng
  Discord của chính họ, thấy nút **Developers** ở đầu trang, và sửa được danh sách của bạn. Họ không thấy gì
  khác của bạn.
- Trang cập nhật **tức thì**: ai lưu thay đổi thì mọi người đang xem đều thấy trong vòng một giây, không cần tải
  lại trang.
- **Từ ClickUp:** khi tracker đã nối với ClickUp của team, mỗi dòng có thể gắn với người đó trên ClickUp (menu
  **ClickUp** trên dòng), hoặc thêm thẳng từ **…or add from ClickUp**. Dưới tên họ sẽ hiện mọi task đang mở của
  họ trên ClickUp, kèm **trạng thái gốc của ClickUp** (dev in progress, code review, blocked, to do…) — việc đang
  làm lên đầu, việc đã xong không hiện — mỗi task là một link. Đọc lại mỗi phút. Dòng gõ tay và menu trạng thái
  vẫn sửa được như cũ. Nếu không đọc được ClickUp, đầu danh sách sẽ báo và nêu lý do.
- **Tự tìm developer:** ai đang có việc chưa xong trên ClickUp sẽ tự được thêm vào danh sách ("Added from
  ClickUp"). Không ai bị tự động bỏ ra — muốn bỏ ai thì bấm **Hide** trên dòng của họ; họ sẽ ẩn luôn kể cả khi
  ClickUp giao thêm việc, và **Hidden (n)** ở cuối danh sách cho hiện lại.
- **Nghĩa của trạng thái:** rê chuột lên một trạng thái ClickUp để xem nghĩa (blocked = đang chờ một việc hay một
  người khác; code review = code đã xong, đang chờ người khác kiểm tra…), hoặc mở **What these statuses mean** ở
  đầu danh sách.
- **Lọc theo trạng thái:** các nút ở đầu danh sách (ví dụ **blocked · 7**) chỉ hiện những developer có task ở trạng
  thái đó, và chỉ những task đó. Chọn nhiều nút để gộp; **Show everyone** để bỏ lọc. Lựa chọn được giữ trên trình
  duyệt của bạn.
- **Note:** ô có nhãn **Note** trên mỗi dòng là ghi chú tay, bổ sung cho ClickUp — điều ClickUp không nói. Nhấn
  Enter để lưu; dòng đó ghi ai viết và lúc nào.
- **Mọi task, kể cả đã xong:** mỗi dòng hiện việc đang mở trước, rồi **Done (n)** — bấm để xem việc đã xong, mới
  nhất trước. Lọc theo một trạng thái đã xong (live, code merged…) cũng hiện các task đó.
- **Developer xem task của mình:** developer đăng nhập tracker bằng Discord sẽ thấy **Your ClickUp tasks** trên trang
  này — mọi task giao cho họ, đang mở và đã xong — và không thấy của ai khác. Họ không bao giờ thấy ghi chú hay
  trạng thái bạn đặt cho họ. Tracker biết họ là ai khi email Discord trùng đúng email ClickUp; nếu không, chọn ở
  **Signs in as…** trên dòng của họ.

### 6.10 Ask — "mình đã giao task về… cho ai chưa?"

Bấm **Ask** ở đầu board (hiện khi đã nối bot Discord và key Anthropic) rồi gõ câu hỏi bằng lời thường — "Did I
give anyone a task about the GPU server?", "ai đang làm thumbnail?", tiếng Anh hay tiếng Việt đều được. Claude đọc
mọi task bạn đã giao, cả đang mở lẫn đã xong, và so khớp theo nghĩa chứ không chỉ đúng chữ. Bạn nhận một câu trả lời
ngắn và các task khớp — ai đang làm, đang ở đâu, giao ngày nào, hạn khi nào; bấm vào để mở. Không có task nào khớp
thì nó nói rõ là không có. Chạy bằng key Anthropic của chính bạn và chỉ đọc task của bạn.

---

## 7. Nhắc việc

- **Chỉ task có hạn chót** và còn mở mới được nhắc.
- **Khi nào:**
  - trước hạn 1 ngày, trước hạn 1 giờ, và đúng lúc đến hạn;
  - thêm vào đó, theo tần suất bạn chọn;
  - sau hạn, nhắc của bạn vẫn tiếp tục, và dừng khi quá hạn 30 ngày.
- **Gửi cho ai:** người nhận (DM từ bot của bạn) và bạn. Bản của bạn có một dòng cho biết việc nhắc người nhận
  đang thế nào.
- **"No reminder" chỉ tắt nhắc của BẠN.** Người nhận vẫn được nhắc trước 1 ngày, trước 1 giờ, đúng hạn, và
  tối đa 3 lần sau hạn (mỗi ngày một lần).
- **Người nhận chỉ được nhắc tối đa 3 lần sau hạn.** Lần thứ ba ghi rõ là lần cuối, và nhắc của bạn sẽ báo để
  bạn tự hỏi lại họ.
- **Đổi hạn chót thì đếm lại từ đầu.** Đổi người nhận thì người mới được nhắc lại từ đầu.
- **Khi tracker ngừng chạy:** lúc chạy lại bạn nhận một lần nhắc, không phải một loạt nhắc bù.

---

## 8. Nếu bạn là người được giao việc

### 8.1 My tasks — mọi việc của bạn ở một chỗ

Đăng nhập tracker bằng Discord. Bạn không cần bot hay key riêng. Nếu không có bot, bạn vào thẳng trang
**My tasks**; nếu có bot, bấm nút **My tasks** ở đầu board. Trang này hiển thị:

- **mọi việc ai đó giao cho bạn qua tracker**, dù họ tag bot trong kênh hay nhắn riêng cho bot, từ bất kỳ tài
  khoản nào;
- **những việc của bạn trong chính tài khoản của bạn**;
- các việc **xếp theo độ gấp**: Overdue · Due today · This week · Later · No deadline · Finished in the last 14
  days;
- mỗi việc có: ai giao, giao từ đâu, đang ở stage nào, và đồng hồ đếm ngược;
- các nút: **Start** (báo bạn đang làm), **Report done…** (báo đã xong), và **Stop reminding me** / **Remind me
  again**.

**Nhận một việc không phải của mình** — bạn chỉ được nhắc tên? Mở thẻ và bấm **Not mine**: người giao được báo và có
thể gỡ bạn ra. Đừng báo xong; làm vậy sẽ tính đó là việc của bạn.

**Report done…** yêu cầu **bằng chứng** — vài dòng mô tả việc đã làm, một link, hoặc file (tối đa 50 MB mỗi file;
file lớn hơn thì gửi link). Bắt buộc phải có. Sau đó việc hiện là **Finished · awaiting review** cho đến khi
người giao quyết định: duyệt (đúng hạn, hoặc trễ hạn: −1), không duyệt (−1, mở lại với hạn mới, kèm lý do), hoặc
gia hạn (không trừ điểm). Bot của họ DM cho bạn kết quả. Mọi lần cộng/trừ điểm đều có trong **Scores**, kèm lý do
và ai quyết định — chỉ bạn và Lucky35 xem được điểm của bạn.

**Moved off you** liệt kê những việc người giao đã chuyển cho người khác (hoặc gỡ khỏi bạn) trong 14 ngày qua. Bot
của họ DM cho bạn khi việc bị chuyển, việc biến khỏi trang này ngay, và bạn không còn bị nhắc về nó.

Mọi DM bot gửi cho bạn đều có link tới trang này ở cuối.

### 8.2 Trả lời ngay trên Discord

- **Khi ai đó giao việc cho bạn bằng DM tới bot của họ**, hoặc chọn bạn trên board, bot của họ DM cho bạn:
  "**Luka** gave you a task". (Việc giao trong kênh thì @-nhắc bạn thay cho tin này.)
- **Nhắc việc** đến dưới dạng DM từ bot của người giao. Mỗi tin có tên việc, hạn chót theo múi giờ *của bạn*, và
  link. Để nhận được DM, bạn phải ở chung một server với bot đó và cho phép DM từ thành viên server.
- **Reply vào bất kỳ DM nào trong số đó** bằng `start` (bạn đang làm), `stop` (tắt nhắc việc đó), hoặc
  **bằng chứng** việc đã xong — ảnh chụp màn hình, file, link, hoặc vài dòng mô tả. Chỉ gõ `done` là chưa đủ:
  bot sẽ hỏi bằng chứng, và câu trả lời của bạn cho câu hỏi đó chính là bằng chứng.
- **Trong kênh,** tag bot kèm bằng chứng — tốt nhất là reply vào tin đã giao việc cho bạn. Nếu không reply: chỉ
  có một việc của người đó đang mở thì bằng chứng gắn vào việc đó; có nhiều việc thì bot liệt kê và bạn reply
  bằng số thứ tự.
- **Nếu việc bị mở lại hoặc được gia hạn,** bot của họ DM cho bạn lý do và hạn mới. Làm xong thì reply bằng
  chứng vào DM đó.
- **Nhắn bot `my tasks`** để xem danh sách việc người đó giao cho bạn.
- **Muốn nhờ chủ bot việc gì**, nhắn yêu cầu cho bot. Bot hỏi lại trước: "Send this to **Luka** as a task? Reply
  `yes`". Chỉ khi bạn reply `yes` vào câu hỏi đó thì việc mới lên board của họ; `no` là bỏ. Câu "ok, cảm ơn" hay
  tán gẫu chỉ nhận 👀, không đi đâu cả.
- **Tin cũ vẫn được đọc.** Reply `done` vào một tin nhắc từ nhiều tuần trước vẫn được đọc và trả lời, chậm nhất
  trong một giờ. Nếu việc đó đã đóng, hoặc đã chuyển cho người khác, bot nói rõ.

**Mọi thứ khác thuộc về người giao.** Họ được báo những gì bạn làm. Nếu bạn tắt rồi bật lại nhắc trong vài phút,
họ nhận một tin duy nhất về trạng thái cuối cùng — không bao giờ im lặng, cũng không dồn nhiều tin.

---

## 9. Giới hạn (quy định của Discord, không phải cài đặt)

- **Không bot nào đọc được DM giữa hai người.** Bot của bạn chỉ đọc DM gửi **cho chính nó**: từ bạn, và từ những
  người bạn đã giao việc hoặc có ghi chú. Cuộc trò chuyện nào bot đã đọc thì bot đọc mãi — mỗi phút khi còn việc,
  ít nhất mỗi giờ sau đó. Discord không cho bot tìm ra cuộc trò chuyện do người khác mở trước, nên người lạ nhắn
  cho bot trước sẽ không được đọc.
- **Bot chỉ thấy server nó được mời vào**, và kênh nó được phép đọc.
- **Tin xuất hiện sau khoảng một phút**, vì tracker kiểm tra mỗi phút một lần.
- **Tin được sửa:** tag thêm bằng cách sửa được nhận ra khi tin đó nằm trong 100 tin mới nhất của kênh. Xa hơn
  thì Backfill tìm ra. Tin bị xoá thì không được nhận ra.
- **Việc theo dõi một kênh bắt đầu từ lúc bạn bật nó.** Tin trước đó cần **Backfill past tasks**.

---

## 10. Xử lý sự cố

| Vấn đề | Cách xử lý |
|---|---|
| Hiện thông báo **Not tracking yet** | Làm cho xong Settings: bot, Claude, ít nhất một kênh. |
| Thẻ đến mà trống chữ | Bật **Message Content Intent** ở tab Bot của bot. |
| Một kênh không có ✅, và có thông báo **cannot react** | Bấm **Invite again** cho server đó. Tag ở đó vẫn được tạo thẻ, và được trả lời qua DM. |
| "Claude reported … only Haiku …" | Bạn đang dùng gói subscription. Chọn **Claude Haiku 4.5**. |
| Hạn chót lệch vài tiếng | Kiểm tra **Your time zone** trong Settings. |
| Bot đánh giá sai một tin | Mở **Not filed** và bấm **Make it a task**. |
| Có thẻ bạn không muốn | **Dismiss** (vẫn giữ trong Done & dismissed) hoặc **Delete**. |
| Thẻ ghi "Filed from the message's own words — Claude could not read it" | Claude không chịu đọc tin đó. Kiểm tra lại tiêu đề và chi tiết. |
| Người nhận không được nhắc | Đọc dòng dưới phần hạn chót. Có thể DM của họ bị chặn, họ đã tắt nhắc, hoặc đã hết số lần nhắc sau hạn. |
| Settings hiện **History to read again** | Bấm **Backfill past tasks**. |
| Backfill bỏ qua một kênh | Thông báo ghi rõ lý do, thường là thiếu quyền *Read Message History*. Sửa quyền rồi bấm lại. |

---

## 11. Quyền riêng tư

- **Bot của bạn, Claude của bạn.** Không tin nhắn của ai bị đọc bằng tài khoản của người khác.
- **Chỉ tin có tag bot của bạn mới được lưu.**
- **Token và key được mã hoá** và không bao giờ gửi tới trình duyệt.
- **Không ai xem được board của người khác**, trừ những task được giao cho chính họ.
