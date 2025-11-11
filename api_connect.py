from openai import OpenAI
import openai

client = OpenAI(api_key="your-api-key-here")

def generate_flashcards(topic, num_cards=5):
    prompt = f"Generate {num_cards} flashcards on the topic '{topic}'. Format each as:\nQ: <question>\nA: <answer>"

    response = client.chat.completions.create(
        model="gpt-5-nano",
        messages=[{"role": "user", "content": prompt}],
        temperature=1.0
    )

    content = response.choices[0].message.content
    flashcards = []
    question = ""

    if content:
        for line in content.split('\n'):
            if line.startswith("Q:"):
                question = line[3:].strip()
            elif line.startswith("A:"):
                answer = line[3:].strip()
                flashcards.append((question, answer))
    return flashcards

def semantic_match(user_answer, correct_answer):
    prompt = f"Is the user's answer '{user_answer}' semantically correct for the question with answer '{correct_answer}'? Reply with Yes or No."
    response = client.chat.completions.create(
        model="gpt-5-nano",
        messages=[{"role": "user", "content": prompt}],
        temperature=1.0
    )
    content = ""
    if response and getattr(response, "choices", None):
        choice = response.choices[0]
        message = getattr(choice, "message", None)
        content = (getattr(message, "content", None) or "")
    return content.strip().lower().startswith("yes")