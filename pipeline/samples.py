"""Known display-referred sRGB examples; no camera-capture claim."""
from pipeline.common import PUBLIC, save_json
import numpy as np
from PIL import Image, ImageCms
from skimage import data

SAMPLES = [
    {"id": "coffee", "name": "오후의 커피", "category": "정물 · 따뜻한 색", "credit": "Rachel Michetti · CC0 · courtesy of Pikolo Espresso Bar", "source": "https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.coffee"},
    {"id": "astronaut", "name": "빛과 피부", "category": "인물 · 피부 톤", "credit": "NASA · public domain · Eileen Collins", "source": "https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut"},
    {"id": "chelsea", "name": "작은 친구", "category": "디테일 · 중간 톤", "credit": "Stefan van der Walt · CC0", "source": "https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.chelsea"},
    {"id": "chart", "name": "컬러 테스트", "category": "그레이 램프 · 색 패치", "credit": "Film Lab · generated technical test pattern · CC0", "source": None},
]


def chart():
    result = np.zeros((400, 600, 3), dtype=np.uint8)
    colors = [(180,130,110),(115,80,65),(120,150,190),(80,120,70),(160,90,140),(50,160,175),
              (230,120,45),(80,85,170),(190,60,70),(130,80,140),(170,190,65),(235,170,45),
              (30,60,190),(40,155,70),(200,35,40),(230,210,40),(200,60,165),(35,170,195)]
    result[:300] = 32
    for i,c in enumerate(colors):
        y,x=divmod(i,6)
        result[y*100+8:(y+1)*100-8,x*100+8:(x+1)*100-8]=c
    result[310:] = np.round(np.linspace(0,255,600))[None,:,None].astype(np.uint8)
    return result


def save_image(rgb, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    Image.fromarray(np.round(np.clip(rgb,0,1)*255).astype(np.uint8)).save(path, quality=90, icc_profile=profile)


def prepare():
    for sample in SAMPLES:
        rgb = chart() if sample["id"] == "chart" else getattr(data,sample["id"])()
        # Keep identical geometry for both halves; never crop source differently.
        sample["width"],sample["height"] = rgb.shape[1],rgb.shape[0]
        sample["path"] = f"/samples/{sample['id']}.webp"
        sample["input"] = "display-referred sRGB; analytically re-encoded as V-Log before LUT"
        save_image(rgb/255., PUBLIC / sample["path"].lstrip("/"))
    save_json(PUBLIC / "samples/manifest.json", SAMPLES)
    return SAMPLES


if __name__ == "__main__":
    prepare()
