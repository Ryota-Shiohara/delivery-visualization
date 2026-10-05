import json
import boto3
from decimal import Decimal

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table("delivery-testDB")


def lambda_handler(event, context):
    print("event:", event)

    # API Gatewayから送られてきたPOST本文をJSONに戻す
    body = json.loads(event["body"], parse_float=Decimal)

    # DynamoDBへ保存
    table.put_item(Item=body)

    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json"
        },
        "body": json.dumps({
            "message": "saved",
            "measurementId": body["measurementId"]
        })
    }