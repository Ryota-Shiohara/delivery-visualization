import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch


class ImpactIndexTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        dependencies = {name: MagicMock() for name in (
            'boto3', 'boto3.dynamodb', 'boto3.dynamodb.types',
            'botocore', 'botocore.exceptions')}
        dependencies['botocore.exceptions'].ClientError = type('ClientError', (Exception,), {})
        path = Path(__file__).resolve().parents[1] / 'services/analysis/analysis1.py'
        with patch.dict(sys.modules, dependencies), patch.dict(os.environ, {'IMPACT_THRESHOLD': '25'}):
            spec = importlib.util.spec_from_file_location('impact_analysis_test', path)
            cls.analysis = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.analysis)

    def test_only_impact_measurements_receive_index_key(self):
        for vibration, expected in ((0, False), (24.9, False), (25, True), (25.1, True)):
            with self.subTest(vibration=vibration):
                result = self.analysis.analyze_measurement({
                    'measurementId': 'm', 'deliveryId': 'delivery',
                    'measuredAt': '2026-10-19T00:00:00Z',
                    'acceleration': {'x': vibration, 'y': 0, 'z': 0, 'includesGravity': False},
                    'position': None,
                })
                self.assertEqual(result['isImpact'], expected)
                self.assertEqual('impactDeliveryId' in result, expected)
                if expected:
                    self.assertEqual(result['impactDeliveryId'], 'delivery')
                    self.assertEqual(self.analysis.to_ddb(result)['impactDeliveryId'], 'delivery')


if __name__ == '__main__':
    unittest.main()
