from retrieval.embedding_service import embed_text
from retrieval.query_example_repository import find_similar_examples


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


def print_results(question: str, limit: int):
    embedding = embed_text(question)
    examples = find_similar_examples(embedding, limit=limit)

    print("=" * 90)
    print(f"QUESTION: {question}")
    print(f"TOP {limit}")
    print("-" * 90)

    for index, example in enumerate(examples, start=1):
        print(
            f"{index}. {example['question']}\n"
            f"   similarity={example['similarity']:.4f}\n"
            f"   category={example['category']}\n"
        )


def main():
    for question in TEST_QUESTIONS:
        print_results(question, 3)
        print_results(question, 5)


if __name__ == "__main__":
    main()