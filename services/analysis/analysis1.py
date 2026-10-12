import logging
import os
import math
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)
deserializer = TypeDeserializer()
dynamodb = boto3.resource("dynamodb")

G = 9.80665

# ---- 仮の値(実測で調整する) ----
CELL_SIZE = 0.0005         # 区画の大きさ(度)。緯度方向で約55m
IMPACT_THRESHOLD = 3.0     # 揺れがこれ以上なら「衝撃」(m/s^2)
MIN_SAMPLES = 3            # 区画が「評価済み」になる最小測定数
ACCURACY_LIMIT_M = 30.0    # GPS精度がこれより悪いデータは区画集計に使わない(m)
VIB_WEIGHT = 5             # 揺れの減点の重み
TILT_WEIGHT = 2            # 傾きの減点の重み


def cell_id(lat, lon):
    return f"{round(lat / CELL_SIZE)}_{round(lon / CELL_SIZE)}"


def from_dynamodb_image(image: dict) -> dict:
    return {k: deserializer.deserialize(v) for k, v in image.items()}

# 1件の分析
def analyze_measurement(m: dict) -> dict:
    acc = m["acceleration"]
    x, y, z = float(acc["x"]), float(acc["y"]), float(acc["z"])
    tilt = float(m.get("tiltDegrees") or 0)
    
    magnitude = math.sqrt(x * x + y * y + z * z)

    if acc.get("includesGravity", True):
        vibration = abs(magnitude - G)
    else:
        vibration = magnitude

    # スコア計算　揺れの重み、傾きの重み
    score = max(0.0, 100 - vibration * VIB_WEIGHT - tilt * TILT_WEIGHT)
    
    pos = m.get("position") or {}

    return {
        "measurementId": m["measurementId"],
        "deliveryId": m["deliveryId"],
        "measuredAt": m["measuredAt"],
        "analyzedAt": datetime.now(timezone.utc).isoformat(),
        "qualityScore": round(score, 2),
        "vibration": round(vibration, 2),
        "isImpact": vibration >= IMPACT_THRESHOLD,
        "tiltDegrees": tilt,
        "latitude": pos.get("latitude"),
        "longitude": pos.get("longitude"),
        "accuracyMeters": pos.get("accuracyMeters"),
        "speedMetersPerSecond": pos.get("speedMetersPerSecond"),
        "algorithmVersion": "prototype-0.3",
    }


def to_ddb(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: to_ddb(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_ddb(v) for v in value]
    return value


def update_max(table, key, attr, value):
    """今の値より大きいときだけ更新する"""
    try:
        table.update_item(
            Key=key,
            UpdateExpression=f"SET {attr} = :v",
            ConditionExpression=f"attribute_not_exists({attr}) OR {attr} < :v",
            ExpressionAttributeValues={":v": value},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def update_delivery(result):
    """配送(deliveryId)ごとの集計"""
    # 環境変数
    name = os.environ.get("DELIVERY_TABLE_NAME")
    if not name:
        return
    # table
    table = dynamodb.Table(name)
    key = {"deliveryId": result["deliveryId"]}
    vib = Decimal(str(result["vibration"]))

    resp = table.update_item(
        Key=key,
        UpdateExpression=(
            "ADD sampleCount :one, impactCount :imp, "
            "vibrationSum :vib, scoreSum :sc "
            "SET updatedAt = :now"
        ),
        ExpressionAttributeValues={
            ":one": 1,
            ":imp": 1 if result["isImpact"] else 0,
            ":vib": vib,
            ":sc": Decimal(str(result["qualityScore"])),
            ":now": result["analyzedAt"],
        },
        ReturnValues="ALL_NEW",
    )
    item = resp["Attributes"]
    # 平均スコア
    avg_score = (item["scoreSum"] / item["sampleCount"]).quantize(Decimal("0.01"))
    
    table.update_item(
        Key=key,
        UpdateExpression="SET avgScore = :a",
        ExpressionAttributeValues={":a": avg_score},
    )
    # maxVibration, maxTilt
    update_max(table, key, "maxVibration", vib)
    update_max(table, key, "maxTilt", Decimal(str(result["tiltDegrees"])))


def update_cell(result):
    """位置の区画ごとの集計(路面評価)"""
    lat, lon = result.get("latitude"), result.get("longitude")
    if lat is None or lon is None:
        return
    acc = result.get("accuracyMeters")
    if acc is not None and float(acc) > ACCURACY_LIMIT_M:
        return  # GPS精度が悪いデータは使わない
    name = os.environ.get("CELL_TABLE_NAME")
    if not name:
        return

    table = dynamodb.Table(name)
    lat, lon = float(lat), float(lon)
    key = {"cellId": cell_id(lat, lon)}
    vib = Decimal(str(result["vibration"]))

    resp = table.update_item(
        Key=key,
        UpdateExpression=(
            "ADD sampleCount :one, vibrationSum :v, impactCount :imp "
            "SET updatedAt = :now"
        ),
        ExpressionAttributeValues={
            ":one": 1,
            ":v": vib,
            ":imp": 1 if result["isImpact"] else 0,
            ":now": result["analyzedAt"],
        },
        ReturnValues="ALL_NEW",
    )
    item = resp["Attributes"]
    count = int(item["sampleCount"])
    avg = (item["vibrationSum"] / item["sampleCount"]).quantize(Decimal("0.001"))
    status = "evaluated" if count >= MIN_SAMPLES else "reference"

    center_lat = round(round(lat / CELL_SIZE) * CELL_SIZE, 6)
    center_lon = round(round(lon / CELL_SIZE) * CELL_SIZE, 6)
    table.update_item(
        Key=key,
        UpdateExpression=(
            "SET avgVibration = :a, evalStatus = :st, "
            "centerLat = :clat, centerLon = :clon"
        ),
        ExpressionAttributeValues={
            ":a": avg,
            ":st": status,
            ":clat": Decimal(str(center_lat)),
            ":clon": Decimal(str(center_lon)),
        },
    )

    update_max(table, key, "maxVibration", vib)


def lambda_handler(event, context):
    table = dynamodb.Table(os.environ["ANALYSIS_TABLE_NAME"])
    failures = []

    for record in event.get("Records", []):
        if record.get("eventName") != "INSERT":
            continue
        seq = record["dynamodb"].get("SequenceNumber")
        try:
            m = from_dynamodb_image(record["dynamodb"]["NewImage"])
            result = analyze_measurement(m)
            table.put_item(
                Item=to_ddb(result),
                ConditionExpression="attribute_not_exists(measurementId)",
            )
            update_delivery(result)
            update_cell(result)
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                continue
            logger.exception("save failed")
            failures.append({"itemIdentifier": seq})
        except (KeyError, TypeError, ValueError):
            logger.exception("invalid record")
            failures.append({"itemIdentifier": seq})

    return {"batchItemFailures": failures}