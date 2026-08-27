import asyncio

from tools.query_database import query_database


TEST_QUESTIONS = [
    # Sales
    "Which customers spent the most money with us?",
    "What products sold the most units?",
    "Which products generated the most revenue?",
    "Which warehouse shipped the most units to customers?",

    # Inventory
    "How much stock do we actually have available?",
    "How many laptops are available in each warehouse?",
    "What products are currently in the Main warehouse?",
    "Which products are stocked in more than one warehouse?",

    # Reservations
    "What stock is reserved right now?",
    "Which customer orders currently have reserved stock?",
    "Which transfers are holding reserved stock?",

    # Suppliers / purchasing
    "Which supplier delivered the most units?",
    "How much have we spent with each supplier?",
    "What incoming deliveries are overdue?",
    "What supplier deliveries are still pending?",

    # Transfers / capacity
    "Which warehouses are almost full?",
    "How much unused capacity does each warehouse have?",
    "What transfers are still pending?",
    "Which products are transferred between warehouses the most?",

    # History / auditing
    "Show me the stock movement history for laptops.",
    "Does inventory match the stock movement ledger?",
    "How many transactions do we have of each type and status?",
    "What was the net stock change in each warehouse during the last 30 days?",
]


async def main():
    passed = 0
    failed = 0

    for question in TEST_QUESTIONS:
        print("=" * 100)
        print(f"QUESTION: {question}")

        try:
            result = await query_database(question)

            print("\nRETRIEVED EXAMPLES:")
            for example in result["retrievedExamples"]:
                print(
                    f"- {example['question']} "
                    f"({example['similarity']:.4f})"
                )

            print("\nGENERATED SQL:")
            print(result["sql"])

            print("\nROWS:")
            for row in result["rows"][:5]:
                print(row)

            print(f"\nReturned rows: {len(result['rows'])}")
            print("\nSTATUS: PASS")
            passed += 1

        except Exception as exc:
            print(
                f"\nSTATUS: FAIL\n"
                f"{type(exc).__name__}: {exc}"
            )
            failed += 1

        print()

    print("=" * 100)
    print("FINAL SUMMARY")
    print(f"Passed: {passed}")
    print(f"Failed: {failed}")
    print(f"Total:  {len(TEST_QUESTIONS)}")


if __name__ == "__main__":
    asyncio.run(main())