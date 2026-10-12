import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from decimal import Decimal
from unittest.mock import MagicMock, patch


# boto3を置き換え、AWSの認証情報やネットワークを使用しない。
with patch.dict(sys.modules, {"boto3": MagicMock()}):
    spec = importlib.util.spec_from_file_location("handler_under_test", Path(__file__).with_name("lambda_B.py"))
    handler = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(handler)


class HandlerTests(unittest.TestCase):
    def setUp(self):
        handler.table = MagicMock()

    def test_save_single_measurement_with_cors_and_decimal(self):
        body = {"measurementId": "one", "acceleration": {"z": 9.81}, "mode": "demo"}
        with patch.dict(os.environ, {"CORS_ORIGIN": "https://collector.example"}):
            result = handler.lambda_handler({"body": json.dumps(body)}, None)
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(result["headers"]["Access-Control-Allow-Origin"], "https://collector.example")
        self.assertEqual(json.loads(result["body"]), {"message": "saved", "measurementId": "one"})
        self.assertEqual(handler.table.put_item.call_args.kwargs["Item"]["acceleration"]["z"], Decimal("9.81"))

    def test_invalid_request_does_not_write(self):
        for body in ["invalid", "[]", "{}", '{"measurementId":42}', '{"measurementId":""}']:
            result = handler.lambda_handler({"body": body}, None)
            self.assertEqual(result["statusCode"], 400)
            self.assertIn("Access-Control-Allow-Origin", result["headers"])
        handler.table.put_item.assert_not_called()

    def test_storage_failure_returns_cors_without_confirmation(self):
        handler.table.put_item.side_effect = RuntimeError("private storage detail")
        result = handler.lambda_handler({"body": '{"measurementId":"one"}'}, None)
        self.assertEqual(result["statusCode"], 500)
        self.assertIn("Access-Control-Allow-Origin", result["headers"])
        self.assertNotIn("private storage detail", result["body"])


if __name__ == "__main__":
    unittest.main()
