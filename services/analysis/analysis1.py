# 最新。calibrate

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
IMPACT_THRESHOLD = float(os.environ.get("IMPACT_THRESHOLD", "25"))  # 揺れがこれ以上なら「衝撃」(m/s^2)。チームで25に決定
MIN_SAMPLES = 3            # 区画が「評価済み」になる最小測定数
ACCURACY_LIMIT_M = 30.0    # GPS精度がこれより悪いデータは区画集計に使わない(m)

# ---- スコアの係数(calibrate.py の結果を、Lambdaの環境変数に入れる) ----
# 歩きを基準に「何SD悪いか」を測り、傾きの重み W_TILT で混ぜて、100点から K 倍して引く。
# 下の値は、歩き・小走り・走りの予備実験から calibrate.py で決めた値(calibrated-2.0)。
# 環境変数を設定すれば、そちらが優先される。

MU_V = float(os.environ.get("MU_V", "2.861566"))        # 歩きの揺れの平均(m/s^2)
SIGMA_V = float(os.environ.get("SIGMA_V", "2.272312"))  # 歩きの揺れのSD
MU_T = float(os.environ.get("MU_T", "7.79291"))         # 歩きの傾きの平均(度)
SIGMA_T = float(os.environ.get("SIGMA_T", "1.462707"))  # 歩きの傾きのSD
W_TILT = float(os.environ.get("W_TILT", "0.65"))        # 傾きの重み(0〜1)。揺れの重みは 1 - W_TILT
K = float(os.environ.get("K", "23.2212"))               # 悪さ1あたりの減点
ALGORITHM_VERSION = os.environ.get("ALGORITHM_VERSION", "calibrated-2.0")


def cell_id(lat, lon):
    return f"{round(lat / CELL_SIZE)}_{round(lon / CELL_SIZE)}"


class ConflictError(Exception):
    """同じ集計行を別の処理が同時に更新し続けて、リトライしても書けなかった"""


def from_dynamodb_image(image: dict) -> dict:
    return {k: deserializer.deserialize(v) for k, v in image.items()}


def quality_score(vibration: float, tilt: float) -> float:
    """配送品質スコア(0〜100、高いほど良好)。calibrate.py の score() と同じ式。"""
    # 歩きより何SD悪いか。歩きより良いときは0(加点はしない)
    v_bad = max(0.0, (vibration - MU_V) / max(SIGMA_V, 1e-9))
    t_bad = max(0.0, (tilt - MU_T) / max(SIGMA_T, 1e-9))
    d = W_TILT * t_bad + (1.0 - W_TILT) * v_bad
    return min(100.0, max(0.0, 100.0 - K * d))


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

    # スコア計算(係数は環境変数。決め方は calibrate.py)
    score = quality_score(vibration, tilt)

    pos = m.get("position") or {}

    result = {
        "measurementId": m["measurementId"],
        "deliveryId": m["deliveryId"],
        "measuredAt": m["measuredAt"],
        "qualityScore": round(score, 2),
        "vibration": round(vibration, 2),
        "isImpact": vibration >= IMPACT_THRESHOLD,
        "tiltDegrees": tilt,
        "latitude": pos.get("latitude"),
        "longitude": pos.get("longitude"),
        "accuracyMeters": pos.get("accuracyMeters"),
        "speedMetersPerSecond": pos.get("speedMetersPerSecond"),
        "algorithmVersion": ALGORITHM_VERSION,
    }
    if result["isImpact"]:
        result["impactDeliveryId"] = result["deliveryId"]
    return result


def to_ddb(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: to_ddb(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_ddb(v) for v in value]
    return value


def mean_next(old_mean, old_count, x, places):
    """平均を、合計を持たずに更新する: (今までの平均 × 件数 + 新しい値) ÷ (件数 + 1)"""
    new = (Decimal(old_mean) * old_count + x) / (old_count + 1)
    return new.quantize(Decimal(places))


def running_update(table, key, build, retries=5):
    """集計行を「読む → 計算 → 件数が変わっていなければ書く」で更新する。
    同時に別の更新が入って件数が変わっていたら、読み直してやり直す。
    build(今の行) は、書き込む項目の dict を返す(sampleCount を必ず含める)"""
    for _ in range(retries):
        item = table.get_item(Key=key, ConsistentRead=True).get("Item")
        attrs = build(item or {})
        names = {f"#{k}": k for k in attrs}
        values = {f":{k}": v for k, v in attrs.items()}
        if item:
            cond = "sampleCount = :old_count"
            values[":old_count"] = item["sampleCount"]
        else:
            cond = "attribute_not_exists(sampleCount)"
        try:
            table.update_item(
                Key=key,
                UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in attrs),
                ConditionExpression=cond,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
            return
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
    raise ConflictError(f"集計行を更新できませんでした: {key}")


def update_delivery(result, now):
    """配送(deliveryId)ごとの集計"""
    # 環境変数
    name = os.environ.get("DELIVERY_TABLE_NAME")
    if not name:
        return
    # table
    table = dynamodb.Table(name)
    key = {"deliveryId": result["deliveryId"]}
    vib = Decimal(str(result["vibration"]))
    tilt = Decimal(str(result["tiltDegrees"]))
    score = Decimal(str(result["qualityScore"]))

    def build(item):
        n = int(item.get("sampleCount", 0))
        return {
            "sampleCount": n + 1,
            "impactCount": int(item.get("impactCount", 0)) + (1 if result["isImpact"] else 0),
            "avgScore": mean_next(item.get("avgScore", 0), n, score, "0.000001"),
            "maxVibration": max(item.get("maxVibration", vib), vib),
            "maxTilt": max(item.get("maxTilt", tilt), tilt),
            "updatedAt": now,
        }

    running_update(table, key, build)


def update_cell(result, now):
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
    score = Decimal(str(result["qualityScore"]))
    center_lat = round(round(lat / CELL_SIZE) * CELL_SIZE, 6)
    center_lon = round(round(lon / CELL_SIZE) * CELL_SIZE, 6)

    def build(item):
        n = int(item.get("sampleCount", 0))
        return {
            "sampleCount": n + 1,
            "impactCount": int(item.get("impactCount", 0)) + (1 if result["isImpact"] else 0),
            "avgScore": mean_next(item.get("avgScore", 0), n, score, "0.000001"),
            "avgVibration": mean_next(item.get("avgVibration", 0), n, vib, "0.000001"),
            "maxVibration": max(item.get("maxVibration", vib), vib),
            "evalStatus": "evaluated" if n + 1 >= MIN_SAMPLES else "reference",
            "centerLat": Decimal(str(center_lat)),
            "centerLon": Decimal(str(center_lon)),
            "updatedAt": now,
        }

    running_update(table, key, build)


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
            now = datetime.now(timezone.utc).isoformat()
            update_delivery(result, now)
            update_cell(result, now)
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                continue
            logger.exception("save failed")
            failures.append({"itemIdentifier": seq})
        except (KeyError, TypeError, ValueError, ConflictError):
            logger.exception("invalid record")
            failures.append({"itemIdentifier": seq})

    return {"batchItemFailures": failures}