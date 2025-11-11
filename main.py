import tkinter as tk
from api_connect import generate_flashcards, semantic_match

class scriptShade:
    def __init__(self, root):
        self.root = root
        self.root.title("scriptShade")
        self.flashcards = []
        self.index = 0
        self.score = 0

        self.topic_entry = tk.Entry(root, font=("Arial", 14))
        self.topic_entry.pack(pady=10)

        self.generate_btn = tk.Button(root, text="Generate Flashcards", command=self.load_flashcards)
        self.generate_btn.pack()

        self.question_label = tk.Label(root, text="", font=("Arial", 16), wraplength=400)
        self.question_label.pack(pady=20)

        self.answer_entry = tk.Entry(root, font=("Arial", 14))
        self.answer_entry.pack()

        self.submit_btn = tk.Button(root, text="Submit Answer", command=self.check_answer)
        self.submit_btn.pack(pady=10)

        self.feedback_label = tk.Label(root, text="", font=("Arial", 12))
        self.feedback_label.pack()

        self.next_btn = tk.Button(root, text="Next", command=self.next_card)
        self.next_btn.pack(pady=10)

        self.score_label = tk.Label(root, text="Score: 0", font=("Arial", 12))
        self.score_label.pack()

    def load_flashcards(self):
        topic = self.topic_entry.get()
        self.flashcards = generate_flashcards(topic)
        self.index = 0
        self.score = 0
        self.show_card()

    def show_card(self):
        if self.index < len(self.flashcards):
            self.question_label.config(text=self.flashcards[self.index][0])
            self.answer_entry.delete(0, tk.END)
            self.feedback_label.config(text="")
        else:
            self.question_label.config(text="Quiz Complete!")
            self.answer_entry.pack_forget()
            self.submit_btn.pack_forget()
            self.next_btn.pack_forget()
            self.feedback_label.config(text=f"Final Score: {self.score}/{len(self.flashcards)}")

    def check_answer(self):
        user_answer = self.answer_entry.get().strip().lower()
        correct_answer = self.flashcards[self.index][1].strip().lower()
        check = semantic_match(user_answer, correct_answer)
        if check:
            self.feedback_label.config(text="✅ Correct!", fg="green")
            self.score += 1
        else:
            self.feedback_label.config(text=f"❌ Incorrect! Correct answer: {self.flashcards[self.index][1]}", fg="red")
        self.score_label.config(text=f"Score: {self.score}")

    def next_card(self):
        self.index += 1
        self.show_card()

    

if __name__ == "__main__":
    root = tk.Tk()
    app = scriptShade(root)
    root.mainloop()