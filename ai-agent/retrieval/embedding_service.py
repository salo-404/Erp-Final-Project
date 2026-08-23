import json

import boto3

from config.settings import settings


AWS_REGION = settings.aws_region
MODEL_ID = settings.bedrock_embedding_model_id
EMBEDDING_DIMENSIONS = settings.embedding_dimensions


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
