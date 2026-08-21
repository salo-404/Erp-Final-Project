import json
import os

import boto3


AWS_REGION = os.getenv("AWS_REGION", "eu-west-1")
MODEL_ID = "amazon.titan-embed-text-v2:0"
EMBEDDING_DIMENSIONS = 512


def embed_text(text: str) -> list[float]:
    client = boto3.client(
        "bedrock-runtime",
        region_name=AWS_REGION,
    )

    response = client.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps(
            {
                "inputText": text,
                "dimensions": EMBEDDING_DIMENSIONS,
                "normalize": True,
            }
        ),
    )

    result = json.loads(response["body"].read())
    embedding = result["embedding"]

    if len(embedding) != EMBEDDING_DIMENSIONS:
        raise ValueError(
            f"Expected {EMBEDDING_DIMENSIONS} dimensions, got {len(embedding)}"
        )

    return embedding