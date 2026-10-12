import json
import os
import boto3
from decimal import Decimal
from botocore.exceptions import ClientError


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])


CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
}


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body)
    }


def validate_measurement(m):
    if not isinstance(m, dict):
        return False

    required = [
        "schemaVersion",
        "measurementId",
        "deviceId",
        "deliveryId",
        "measuredAt",
        "acceleration",
        "mode"
    ]

    for key in required:
        if key not in m:
            return False

    if not isinstance(m["measurementId"], str) or not m["measurementId"]:
        return False

    if m["mode"] not in ("device", "demo"):
        return False

    acceleration = m["acceleration"]

    if not isinstance(acceleration, dict):
        return False

    for key in ("x", "y", "z", "includesGravity"):
        if key not in acceleration:
            return False

    # nullを許可する項目
    # position
    # tiltDegrees
    # position.speedMetersPerSecond

    return True


def save_measurement(measurement):
    measurement_id = measurement["measurementId"]

    try:
        table.put_item(
            Item=measurement,

            # 同じmeasurementIdが既にあれば上書きしない
            ConditionExpression="attribute_not_exists(measurementId)"
        )

        return True

    except ClientError as e:
        code = e.response["Error"]["Code"]

        if code == "ConditionalCheckFailedException":
            # 既にDBに存在する
            # = 前回の送信で保存済みと確認できるので成功扱い
            return True

        print("DynamoDB error:", e)
        return False


def lambda_handler(event, context):
    print("event:", event)

    try:
        body = json.loads(
            event["body"],
            parse_float=Decimal
        )
    except Exception:
        return response(400, {
            "error": "invalid JSON"
        })

    # ----------------------------
    # 新形式：複数件
    # ----------------------------

    if "measurements" in body:
        measurements = body["measurements"]

        if not isinstance(measurements, list):
            return response(400, {
                "error": "measurements must be an array"
            })

        if len(measurements) < 1 or len(measurements) > 50:
            return response(400, {
                "error": "measurements must contain 1 to 50 items"
            })

        # 保存する前に全件検証
        for m in measurements:
            if not validate_measurement(m):
                return response(400, {
                    "error": "invalid measurement"
                })

        ids = [m["measurementId"] for m in measurements]

        # 同一リクエスト内でID重複
        if len(ids) != len(set(ids)):
            return response(400, {
                "error": "duplicate measurementId in request"
            })

        saved_ids = []
        failed_ids = []

        for m in measurements:
            if save_measurement(m):
                saved_ids.append(m["measurementId"])
            else:
                failed_ids.append(m["measurementId"])

        return response(200, {
            "savedMeasurementIds": saved_ids,
            "failedMeasurementIds": failed_ids
        })

    # ----------------------------
    # 旧形式：単一件
    # ----------------------------

    if not validate_measurement(body):
        return response(400, {
            "error": "invalid measurement"
        })

    success = save_measurement(body)

    if not success:
        return response(500, {
            "message": "failed",
            "measurementId": body.get("measurementId")
        })

    # 旧レスポンスを維持
    return response(200, {
        "message": "saved",
        "measurementId": body["measurementId"]
    })