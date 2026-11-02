"""Catch wrong-LUT, double-transform, stale-image, and sample provenance errors."""
import io
import json

import colour
import numpy as np
import pytest
from PIL import Image, ImageCms

from pipeline.common import PUBLIC, ROOT, sha256


def test_camera_samples_are_verified_lut_off_and_color_unchanged():
    manifest = json.loads((PUBLIC / 'samples/manifest.json').read_text())
    cameras = [sample for sample in manifest if sample['inputKind'] == 'camera-std']
    assert len(cameras) == 5
    for sample in cameras:
        meta = sample['cameraMetadata']
        assert meta['Model'] == 'DC-S1M2'
        assert meta['PhotoStyle'] == 'Standard or Custom'
        assert meta['LUT1Opacity'] == meta['LUT2Opacity'] == 0
        assert meta['ColorSpace'] == 'sRGB'
        source = PUBLIC / sample['path'].lstrip('/')
        assert sha256(source) == sample['preparedSha256']
        assert source.read_bytes() == (ROOT / 'assets/samples' / source.name).read_bytes()
        with Image.open(source) as image:
            assert image.info.get('icc_profile')
            assert not image.getexif()
        assert sample['previewLut'] == 'std'


@pytest.mark.parametrize('combo_id', [
    'kodak_portra_400__kodak_portra_endura',
    'fujifilm_c200__fujifilm_crystal_archive_typeii',
])
@pytest.mark.parametrize('sample_id', ['std_playground', 'std_playground_panel', 'std_figures', 'std_closeup', 'std_shelf'])
def test_preview_matches_independently_read_exported_std_cube(combo_id, sample_id):
    catalog = json.loads((PUBLIC / 'catalog.json').read_text())
    combo = next(c for c in catalog['combinations'] if c['id'] == combo_id)
    sample = next(s for s in catalog['samples'] if s['id'] == sample_id)
    source = np.asarray(Image.open(PUBLIC / sample['path'].lstrip('/')), dtype=float) / 255
    # colour-science reads its own RGB grid ordering and interpolates directly
    # on the encoded Standard image. No app adapter or renderer is imported.
    lut = colour.read_LUT(str(PUBLIC / combo['files']['std']['path'].lstrip('/')))
    rendered = lut.apply(source, interpolator=colour.algebra.table_interpolation_tetrahedral)
    expected = Image.fromarray(np.round(np.clip(rendered, 0, 1) * 255).astype(np.uint8))
    output = io.BytesIO()
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
    expected.save(output, format='WEBP', quality=90, icc_profile=profile)
    decoded = np.asarray(Image.open(io.BytesIO(output.getvalue())), dtype=float)
    actual = np.asarray(Image.open(PUBLIC / combo['previews'][sample_id]['path'].lstrip('/')), dtype=float)
    delta = np.abs(actual - decoded)
    # Allow tiny independent floating-point rounding differences before WebP.
    assert delta.mean() < 0.05
    assert np.quantile(delta, .99) <= 1


def test_every_film_paper_choice_has_a_distinct_std_preview():
    catalog = json.loads((PUBLIC / 'catalog.json').read_text())
    ready = [combo for combo in catalog['combinations'] if combo['status'] == 'ready']
    assert len(ready) == 128
    for sample in catalog['samples']:
        assert len({combo['previews'][sample['id']]['sha256'] for combo in ready}) == 128
