"""Independent checks for official source identity, transfer and cube order."""
import hashlib
import io
import zipfile
import colour
import numpy as np
import pytest
from pipeline.fuji import (load_study, official_archive, official_table, flog2_encode,
                           flog2_decode, input_to_flog2, apply_official, SRGB_TO_FGAMUT)
from pipeline.common import srgb_decode, std_to_vlog


def test_official_archive_and_all_ten_sources_are_pinned():
    study=load_study();archive=official_archive()
    assert hashlib.sha256(archive.read_bytes()).hexdigest()==study['sourceSha256']
    with zipfile.ZipFile(archive) as z:
        for look in study['looks']:
            raw=z.read(look['sourceArchivePath'])
            assert hashlib.sha256(raw).hexdigest()==look['sourceSha256']
            assert b'#model:GFX ETERNA 55' in raw
            assert b'#Gamut:F-Gamut to ITU-R BT.709' in raw
            assert b'LUT_3D_SIZE 65' in raw
    assert len({look['sourceSha256'] for look in study['looks']})==10


def test_flog2_matches_published_code_values_and_roundtrip():
    assert np.allclose(flog2_encode([0,.18,.9])*1023,[95,400,570],atol=.65)
    values=np.r_[np.linspace(0,.0008,12),np.geomspace(.001,20,200)]
    assert np.allclose(flog2_decode(flog2_encode(values)),values,atol=1e-12)
    expected=colour.RGB_to_RGB(np.eye(3),'sRGB','ITU-R BT.2020',apply_cctf_decoding=False,apply_cctf_encoding=False)
    # colour's sRGB matrix uses four-decimal published coefficients.
    assert np.allclose(SRGB_TO_FGAMUT.T,expected,atol=9e-5)
    assert np.allclose(SRGB_TO_FGAMUT@np.ones(3),1,atol=1e-12)


def test_std_and_vlog_adapters_agree_for_same_synthetic_linear_values():
    points=np.random.default_rng(14).random((1024,3))
    assert np.allclose(input_to_flog2(points),input_to_flog2(std_to_vlog(points),'vlog'),atol=3e-6)


@pytest.mark.parametrize('film',[look['film'] for look in load_study()['looks']])
def test_official_lut_order_and_gamma_match_independent_colour_reader(film,tmp_path):
    look=next(l for l in load_study()['looks'] if l['film']==film)
    with zipfile.ZipFile(official_archive()) as archive: raw=archive.read(look['sourceArchivePath'])
    path=tmp_path/'source.cube';path.write_bytes(raw)
    lut=colour.read_LUT(str(path))
    points=np.concatenate([np.random.default_rng(8).random((512,3)),np.eye(3),np.zeros((1,3)),np.ones((1,3))])
    # Independently build F-Gamut coordinates from exact D65 primary matrices.
    srgb=colour.models.RGB_COLOURSPACE_sRGB.copy();srgb.use_derived_transformation_matrices(True)
    bt2020=colour.models.RGB_COLOURSPACE_BT2020.copy();bt2020.use_derived_transformation_matrices(True)
    linear=colour.cctf_decoding(points,function='sRGB')
    fg=colour.RGB_to_RGB(linear,srgb,bt2020,apply_cctf_decoding=False,apply_cctf_encoding=False)
    encoded=np.where(fg>=.000889,.245281*np.log10(np.maximum(5.555556*fg+.064829,1e-30))+.384316,8.799461*fg+.092864)
    display=lut.apply(np.clip(encoded,0,1),interpolator=colour.algebra.table_interpolation_tetrahedral)
    expected=colour.cctf_encoding(np.clip(display,0,1)**2.2,function='sRGB')
    assert np.allclose(apply_official(points,film),expected,atol=2e-12)


def test_invalid_input_is_not_silently_interpreted_as_another_profile():
    for values in [[[-.1,0,0]],[[0,1.1,0]],[[np.nan,0,0]],[[0,0]]]:
        with pytest.raises(ValueError):input_to_flog2(values)
    with pytest.raises(ValueError):input_to_flog2([[0,0,0]],'flog2c')


def test_ten_simulations_differ_and_acros_is_monochrome():
    p=np.random.default_rng(53).random((256,3))
    outputs=[apply_official(p,l['film']) for l in load_study()['looks']]
    assert len({x.tobytes() for x in outputs})==10
    acros=apply_official(p,'gfx_acros')
    assert np.max(np.ptp(acros,axis=1))<1e-12
