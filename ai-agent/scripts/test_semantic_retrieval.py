import asyncio

from retrieval.embedding_service import embed_text
from retrieval.query_example_repository import TOP_K, find_similar_examples


TEST_QUESTIONS = [
    "Which customers spent the most money with us?",
    "What products sold the most?",
    "How much stock do we actually have available?",
    "What stock is reserved right now?",
    "Which supplier delivered the most units?",
    "What incoming deliveries are overdue?",
    "Which warehouses are almost full?",
    "What transfers are still pending?",
    "Show me the stock movement history for laptops.",
    "Which warehouse shipped the most units to customers?",
]


async def print_results(question: str):
    embedding = embed_text(question)
    examples = await find_similar_examples(embedding, limit=TOP_K)

    print("=" * 90)
    print(f"QUESTION: {question}")
    print(f"TOP {TOP_K}")
    print("-" * 90)

    for index, example in enumerate(examples, start=1):
        print(
            f"{index}. {example['question']}\n"
            f"   similarity={example['similarity']:.4f}\n"
            f"   category={example['category']}\n"
        )


async def main():
    for question in TEST_QUESTIONS:
        await print_results(question)


if __name__ == "__main__":
    asyncio.run(main())
