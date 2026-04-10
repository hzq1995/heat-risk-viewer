import unittest

import numpy as np
from rasterio.transform import Affine

from scripts.build_hazard_tiles import affine_to_list, compute_hazard_cube, distribution_is_nodata


class BuildHazardTilesTests(unittest.TestCase):
    def test_compute_hazard_cube_accumulates_downward(self) -> None:
        counts = np.array(
            [
                [[2, 0]],
                [[3, 4]],
                [[5, 1]],
            ],
            dtype=np.uint8,
        )
        cube = compute_hazard_cube(counts)
        np.testing.assert_array_equal(cube[3], np.array([[0, 0]], dtype=np.uint16))
        np.testing.assert_array_equal(cube[2], np.array([[5, 1]], dtype=np.uint16))
        np.testing.assert_array_equal(cube[1], np.array([[8, 5]], dtype=np.uint16))
        np.testing.assert_array_equal(cube[0], np.array([[10, 5]], dtype=np.uint16))

    def test_distribution_is_nodata_requires_all_bands_to_match(self) -> None:
        self.assertTrue(distribution_is_nodata(np.full((50,), 255, dtype=np.uint8)))
        self.assertFalse(distribution_is_nodata(np.array([255, 0, 255], dtype=np.uint8)))

    def test_affine_to_list_keeps_gdal_order(self) -> None:
        transform = Affine(1.5, 0.0, 36.6, 0.0, -2.5, -1.2)
        self.assertEqual(affine_to_list(transform), [1.5, 0.0, 36.6, 0.0, -2.5, -1.2])


if __name__ == "__main__":
    unittest.main()
