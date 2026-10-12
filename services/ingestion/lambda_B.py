import json
import os
import boto3
from decimal import Decimal

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ.get("TABLE_NAME", "delivery-testDB"))


def lambda_handler(event, context):
    # 計測値・位置情報をログに出さず、応答にCORSヘッダーを付ける。
    try:
        body = json.loads(event.get("body") or "", parse_float=Decimal)
    except (ValueError, TypeError):
        return response(400, {"message": "invalid JSON"})
    if not isinstance(body, dict) or not isinstance(body.get("measurementId"), str) or not body["measurementId"].strip():
        return response(400, {"message": "measurementId is required"})
    try:
        # 再送では同じmeasurementIdの項目を上書きし、重複項目を作らない。
        table.put_item(Item=body)
    except Exception:
        return response(500, {"message": "save failed"})
    return response(200, {"message": "saved", "measurementId": body["measurementId"]})


def response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": os.environ.get("CORS_ORIGIN", "*"),
        },
        "body": json.dumps(body),
    }
