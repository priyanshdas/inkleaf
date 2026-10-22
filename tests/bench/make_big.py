"""A large, realistic PDF for timing: 300 pages of mixed text, a photo-like
image on every few pages, and a form-ish table. Run: python3 tests/bench/make_big.py"""
from pathlib import Path
import io, random
from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

random.seed(7)
out = Path(__file__).parent / "big.pdf"
words = ("guest room night rate invoice breakfast suite deluxe tariff checkout arrival "
         "booking payment balance service laundry minibar housekeeping concierge").split()

# one noisy photo, reused (like a letterhead image)
img = Image.effect_noise((900, 600), 60).convert("RGB")
buf = io.BytesIO(); img.save(buf, "JPEG", quality=80); buf.seek(0)
photo = ImageReader(buf)

c = canvas.Canvas(str(out), pagesize=A4)
for p in range(300):
    c.setFont("Helvetica-Bold", 16)
    c.drawString(60, 790, f"Hotel Aurora — monthly statement, page {p + 1}")
    c.setFont("Times-Roman", 10.5)
    y = 760
    while y > 80:
        c.drawString(60, y, " ".join(random.choice(words) for _ in range(14)))
        y -= 14
    if p % 3 == 0:
        c.drawImage(photo, 330, 520, 220, 147)
    c.showPage()
c.save()
print(out, out.stat().st_size // 1024, "KB")
