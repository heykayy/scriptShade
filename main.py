import tkinter as tk
from tkinter import ttk, messagebox, filedialog, scrolledtext
import json
import threading
import time
import os
from datetime import datetime
import pickle
from tkinter.font import Font
from api_connect import generate_flashcards, semantic_match, initialize_models, is_ready

class scriptShade:
    def __init__(self, root):
        self.root = root
        self.root.title("✨ Flashcard Master - AI Learning Platform")
        self.root.geometry("1200x800")
        self.root.configure(bg='#f5f7fa')

        
        # Apply theme
        self.setup_styles()
        
        # Initialize variables
        self.flashcards = []
        self.index = 0
        self.score = 0
        self.total_time = 0
        self.start_time = None
        self.streak = 0
        self.max_streak = 0
        self.review_cards = []
        self.session_history = []
        self.categories = {}
        
        # Setup fonts
        self.title_font = Font(family="Helvetica", size=18, weight="bold")
        self.question_font = Font(family="Helvetica", size=14)
        self.feedback_font = Font(family="Helvetica", size=12)
        
        # Show loading screen while models initialize
        self.show_loading_screen()

        # Initialize models in background
        self.init_thread = threading.Thread(target=self.initialize_backend)
        self.init_thread.daemon = True
        self.init_thread.start()

        # Check if models are already loaded (in case of fast startup)
        if is_ready():
            self.on_models_loaded(success=True)
        
        # Load previous session if exists
        self.load_session()
        
        # Start timer
        self.start_time = time.time()
        self.update_timer()

    def show_loading_screen(self):
        """Show loading screen while models download"""
        # Configure root grid to expand the loading frame
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        
        self.loading_frame = ttk.Frame(self.root)
        self.loading_frame.grid(row=0, column=0, sticky="nsew")
        
        ttk.Label(self.loading_frame, 
                 text="🚀 Loading AI Models...", 
                 font=('Helvetica', 16)).grid(pady=20)
        
        self.progress = ttk.Progressbar(self.loading_frame, 
                                        length=300, mode='indeterminate')
        self.progress.grid(pady=10)
        self.progress.start()
        
        self.status_label = ttk.Label(self.loading_frame, 
                                      text="Downloading models (first time only)...")
        self.status_label.grid()
    
    def initialize_backend(self):
        """Initialize models with progress updates"""
        def update_progress(percent, message):
            self.root.after(0, lambda: self.status_label.config(
                text=f"{message} ({percent}%)"
            ))
        
        success = initialize_models(progress_callback=update_progress)
        
        self.root.after(0, lambda: self.on_models_loaded(success))
    
    def on_models_loaded(self, success):
        """Called when models are loaded"""
        self.progress.stop()
        self.loading_frame.destroy()
        
        if success:
            messagebox.showinfo("Ready!", 
                "AI models loaded successfully!\nYou can now generate flashcards for ANY topic.")
        else:
            messagebox.showwarning("Limited Mode", 
                "Running in fallback mode with basic functionality.")
        
        # Enable your main UI here
        self.setup_ui()


    def setup_styles(self):
        """Configure ttk styles"""
        style = ttk.Style()
        style.theme_use('clam')
        
        # Configure colors
        style.configure('Title.TLabel', 
                       background='#4361ee', 
                       foreground='white',
                       font=('Helvetica', 16, 'bold'))
        
        style.configure('Primary.TButton',
                       background='#4361ee',
                       foreground='white',
                       borderwidth=0,
                       focuscolor='none')
        
        style.configure('Success.TButton',
                       background='#4cc9f0',
                       foreground='white')
        
        style.configure('Secondary.TButton',
                       background='#3a0ca3',
                       foreground='white')
        
        style.map('Primary.TButton',
                 background=[('active', '#3a0ca3')])
        
        style.configure('Card.TFrame',
                       background='white',
                       relief='raised',
                       borderwidth=2)

    def setup_ui(self):
        """Setup the user interface"""
        # Configure grid weights before placing widgets
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        
        self.main_container = ttk.Frame(self.root, padding="20")
        self.main_container.grid(row=0, column=0, sticky="nsew")
        
        self.main_container.columnconfigure(1, weight=1)
        
        # Left sidebar
        self.setup_sidebar()
        
        # Main content area
        self.setup_main_content()
        
        # Right sidebar (stats)
        self.setup_stats_sidebar()

    def setup_sidebar(self):
        """Setup the left sidebar for topic input and settings"""
        sidebar = ttk.Frame(self.main_container, padding="10", width=250)
        sidebar.grid(row=0, column=0, sticky="ns", padx=(0, 20))
        
        # Logo
        logo_label = ttk.Label(sidebar, text="📚 Flashcard Master", 
                              font=('Helvetica', 20, 'bold'),
                              foreground='#4361ee')
        logo_label.grid(row=0, column=0, pady=(0, 20), sticky=tk.W)
        
        # Topic Input
        ttk.Label(sidebar, text="Enter Topic:", font=('Helvetica', 11, 'bold')).grid(row=1, column=0, sticky=tk.W, pady=(0, 5))
        
        self.topic_entry = ttk.Entry(sidebar, font=("Arial", 12), width=30)
        self.topic_entry.grid(row=2, column=0, pady=(0, 10), sticky=tk.W+tk.E)
        self.topic_entry.bind('<Return>', lambda e: self.load_flashcards())
        
        # Number of cards selector
        ttk.Label(sidebar, text="Number of Cards:", font=('Helvetica', 11, 'bold')).grid(row=3, column=0, sticky=tk.W, pady=(5, 5))
        
        self.num_cards_var = tk.IntVar(value=10)
        num_cards_frame = ttk.Frame(sidebar)
        num_cards_frame.grid(row=4, column=0, pady=(0, 10), sticky=tk.W+tk.E)
        
        ttk.Button(num_cards_frame, text="-", width=3, 
                  command=lambda: self.adjust_num_cards(-1)).grid(row=0, column=0)
        
        self.num_cards_label = ttk.Label(num_cards_frame, textvariable=self.num_cards_var, 
                                        font=('Helvetica', 12, 'bold'), width=5)
        self.num_cards_label.grid(row=0, column=1, padx=5)
        
        ttk.Button(num_cards_frame, text="+", width=3,
                  command=lambda: self.adjust_num_cards(1)).grid(row=0, column=2)
        
        # Difficulty selector
        ttk.Label(sidebar, text="Difficulty:", font=('Helvetica', 11, 'bold')).grid(row=5, column=0, sticky=tk.W, pady=(5, 5))
        
        self.difficulty_var = tk.StringVar(value="medium")
        difficulty_combo = ttk.Combobox(sidebar, textvariable=self.difficulty_var,
                                       values=["easy", "medium", "hard"], state="readonly", width=28)
        difficulty_combo.grid(row=6, column=0, pady=(0, 10))
        
        # Category filter
        ttk.Label(sidebar, text="Category Filter:", font=('Helvetica', 11, 'bold')).grid(row=7, column=0, sticky=tk.W, pady=(5, 5))
        
        self.category_var = tk.StringVar(value="all")
        self.category_combo = ttk.Combobox(sidebar, textvariable=self.category_var,
                                          state="readonly", width=28)
        self.category_combo.grid(row=8, column=0, pady=(0, 10))
        
        # Generate button
        self.generate_btn = ttk.Button(sidebar, text="🎯 Generate Flashcards", 
                                       command=self.load_flashcards,
                                       style='Primary.TButton')
        self.generate_btn.grid(row=9, column=0, pady=10, sticky=tk.W+tk.E)
        
        # Action buttons
        action_frame = ttk.Frame(sidebar)
        action_frame.grid(row=10, column=0, pady=10, sticky=tk.W+tk.E)
        
        ttk.Button(action_frame, text="💾 Save", command=self.save_session,
                  style='Secondary.TButton', width=10).grid(row=0, column=0, padx=2)
        ttk.Button(action_frame, text="📂 Load", command=self.load_session_file,
                  style='Secondary.TButton', width=10).grid(row=0, column=1, padx=2)
        
        # Study mode selector
        ttk.Label(sidebar, text="Study Mode:", font=('Helvetica', 11, 'bold')).grid(row=11, column=0, sticky=tk.W, pady=(15, 5))
        
        self.study_mode_var = tk.StringVar(value="normal")
        study_frame = ttk.Frame(sidebar)
        study_frame.grid(row=12, column=0, pady=(0, 10), sticky=tk.W+tk.E)
        
        ttk.Radiobutton(study_frame, text="Normal", variable=self.study_mode_var,
                       value="normal").grid(row=0, column=0, sticky=tk.W)
        ttk.Radiobutton(study_frame, text="Review", variable=self.study_mode_var,
                       value="review").grid(row=1, column=0, sticky=tk.W)
        
        # Separator
        ttk.Separator(sidebar, orient='horizontal').grid(row=13, column=0, pady=20, sticky=tk.W+tk.E)

    def setup_main_content(self):
        """Setup the main content area"""
        main_content = ttk.Frame(self.main_container)
        main_content.grid(row=0, column=1, sticky="nsew")
        main_content.columnconfigure(0, weight=1)
        
        # Progress bar
        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(main_content, variable=self.progress_var,
                                           maximum=100, length=400)
        self.progress_bar.grid(row=0, column=0, pady=(0, 20), sticky=tk.W+tk.E)
        
        self.progress_label = ttk.Label(main_content, text="Ready to learn!", 
                                       font=('Helvetica', 10))
        self.progress_label.grid(row=1, column=0, pady=(0, 10))
        
        # Card frame
        self.card_frame = ttk.Frame(main_content, style='Card.TFrame', padding="30")
        self.card_frame.grid(row=2, column=0, pady=10, sticky="nsew")
        
        # Question label with scrollbar
        question_frame = ttk.Frame(self.card_frame)
        question_frame.grid(row=0, column=0, pady=(0, 20), sticky=tk.W+tk.E)
        
        self.question_text = scrolledtext.ScrolledText(question_frame, 
                                                      height=8,
                                                      wrap=tk.WORD,
                                                      font=self.question_font,
                                                      bg='white',
                                                      relief='flat')
        self.question_text.grid(row=0, column=0, sticky="nsew")
        
        # Category and difficulty labels
        info_frame = ttk.Frame(self.card_frame)
        info_frame.grid(row=1, column=0, pady=(0, 20), sticky=tk.W)
        
        self.category_label = ttk.Label(info_frame, text="", 
                                       font=('Helvetica', 10, 'bold'),
                                       foreground='#4361ee')
        self.category_label.grid(row=0, column=0, padx=(0, 10))
        
        self.difficulty_label = ttk.Label(info_frame, text="",
                                         font=('Helvetica', 10))
        self.difficulty_label.grid(row=0, column=1)
        
        # Answer entry
        self.answer_entry = ttk.Entry(self.card_frame, font=("Arial", 14))
        self.answer_entry.grid(row=2, column=0, pady=(0, 10), sticky=tk.W+tk.E)
        self.answer_entry.bind('<Return>', lambda e: self.check_answer())
        
        # Hint system
        self.hint_var = tk.StringVar(value="")
        self.hint_label = ttk.Label(self.card_frame, textvariable=self.hint_var,
                                   font=('Helvetica', 10, 'italic'),
                                   foreground='#666666')
        self.hint_label.grid(row=3, column=0, pady=(0, 10), sticky=tk.W)
        
        # Action buttons
        button_frame = ttk.Frame(self.card_frame)
        button_frame.grid(row=4, column=0, pady=(10, 0))
        
        self.submit_btn = ttk.Button(button_frame, text="✅ Submit Answer", 
                                     command=self.check_answer,
                                     style='Primary.TButton')
        self.submit_btn.grid(row=0, column=0, padx=5)
        
        self.show_answer_btn = ttk.Button(button_frame, text="👁️ Show Answer",
                                         command=self.show_answer,
                                         style='Secondary.TButton')
        self.show_answer_btn.grid(row=0, column=1, padx=5)
        
        self.next_btn = ttk.Button(button_frame, text="➡️ Next Card", 
                                  command=self.next_card,
                                  state='disabled')
        self.next_btn.grid(row=0, column=2, padx=5)
        
        self.hint_btn = ttk.Button(button_frame, text="💡 Hint",
                                  command=self.show_hint)
        self.hint_btn.grid(row=0, column=3, padx=5)
        
        # Feedback area
        self.feedback_text = scrolledtext.ScrolledText(self.card_frame,
                                                      height=4,
                                                      wrap=tk.WORD,
                                                      font=self.feedback_font,
                                                      state='disabled',
                                                      bg='#f8f9fa')
        self.feedback_text.grid(row=5, column=0, pady=(20, 0), sticky=tk.W+tk.E)

    def setup_stats_sidebar(self):
        """Setup the right sidebar for statistics"""
        stats_sidebar = ttk.Frame(self.main_container, padding="10", width=250)
        stats_sidebar.grid(row=0, column=2, sticky="nes", padx=(20, 0))
        
        # Statistics title
        ttk.Label(stats_sidebar, text="📊 Statistics", 
                 font=('Helvetica', 14, 'bold')).grid(row=0, column=0, pady=(0, 20))
        
        # Current session stats
        stats_frame = ttk.LabelFrame(stats_sidebar, text="Current Session", padding="10")
        stats_frame.grid(row=1, column=0, pady=(0, 20), sticky=tk.W+tk.E)
        
        # Score
        score_frame = ttk.Frame(stats_frame)
        score_frame.grid(row=0, column=0, pady=5, sticky=tk.W+tk.E)
        ttk.Label(score_frame, text="Score:", font=('Helvetica', 11)).grid(row=0, column=0, sticky=tk.W)
        self.score_label = ttk.Label(score_frame, text="0", font=('Helvetica', 11, 'bold'))
        self.score_label.grid(row=0, column=1, padx=(10, 0), sticky=tk.E)
        
        # Streak
        streak_frame = ttk.Frame(stats_frame)
        streak_frame.grid(row=1, column=0, pady=5, sticky=tk.W+tk.E)
        ttk.Label(streak_frame, text="Streak:", font=('Helvetica', 11)).grid(row=0, column=0, sticky=tk.W)
        self.streak_label = ttk.Label(streak_frame, text="0", font=('Helvetica', 11, 'bold'))
        self.streak_label.grid(row=0, column=1, padx=(10, 0), sticky=tk.E)
        
        # Progress
        progress_frame = ttk.Frame(stats_frame)
        progress_frame.grid(row=2, column=0, pady=5, sticky=tk.W+tk.E)
        ttk.Label(progress_frame, text="Progress:", font=('Helvetica', 11)).grid(row=0, column=0, sticky=tk.W)
        self.progress_stats_label = ttk.Label(progress_frame, text="0/0", font=('Helvetica', 11, 'bold'))
        self.progress_stats_label.grid(row=0, column=1, padx=(10, 0), sticky=tk.E)
        
        # Accuracy
        accuracy_frame = ttk.Frame(stats_frame)
        accuracy_frame.grid(row=3, column=0, pady=5, sticky=tk.W+tk.E)
        ttk.Label(accuracy_frame, text="Accuracy:", font=('Helvetica', 11)).grid(row=0, column=0, sticky=tk.W)
        self.accuracy_label = ttk.Label(accuracy_frame, text="0%", font=('Helvetica', 11, 'bold'))
        self.accuracy_label.grid(row=0, column=1, padx=(10, 0), sticky=tk.E)
        
        # Timer
        timer_frame = ttk.Frame(stats_frame)
        timer_frame.grid(row=4, column=0, pady=5, sticky=tk.W+tk.E)
        ttk.Label(timer_frame, text="Time:", font=('Helvetica', 11)).grid(row=0, column=0, sticky=tk.W)
        self.timer_label = ttk.Label(timer_frame, text="00:00", font=('Helvetica', 11, 'bold'))
        self.timer_label.grid(row=0, column=1, padx=(10, 0), sticky=tk.E)
        
        # Session history
        history_frame = ttk.LabelFrame(stats_sidebar, text="Recent Answers", padding="10")
        history_frame.grid(row=2, column=0, pady=(0, 20), sticky=tk.W+tk.E)
        
        self.history_listbox = tk.Listbox(history_frame, height=6, font=('Helvetica', 9))
        self.history_listbox.grid(row=0, column=0, sticky="nsew")
        
        # Quick actions
        actions_frame = ttk.LabelFrame(stats_sidebar, text="Quick Actions", padding="10")
        actions_frame.grid(row=3, column=0, sticky=tk.W+tk.E)
        
        ttk.Button(actions_frame, text="📈 View Analytics", 
                  command=self.show_analytics).grid(row=0, column=0, pady=5, sticky=tk.W+tk.E)
        ttk.Button(actions_frame, text="🔄 Reset Session", 
                  command=self.reset_session).grid(row=1, column=0, pady=5, sticky=tk.W+tk.E)
        ttk.Button(actions_frame, text="🎯 Review Mistakes", 
                  command=self.review_mistakes).grid(row=2, column=0, pady=5, sticky=tk.W+tk.E)

    def adjust_num_cards(self, delta):
        """Adjust number of cards"""
        current = self.num_cards_var.get()
        new_val = max(5, min(20, current + delta))
        self.num_cards_var.set(new_val)

    def load_flashcards(self):
        """Load flashcards in a separate thread"""
        topic = self.topic_entry.get().strip()
        if not topic:
            messagebox.showwarning("Input Required", "Please enter a topic")
            return
        
        # Disable generate button and show loading
        self.generate_btn.config(state='disabled', text="⏳ Generating...")
        self.progress_label.config(text=f"Generating flashcards for '{topic}'...")
        
        # Run in separate thread to prevent GUI freeze
        def generate_thread():
            try:
                # Generate flashcards
                num_cards = self.num_cards_var.get()
                difficulty = self.difficulty_var.get()
                
                # Get flashcards (enhanced API should return structured data)
                raw_cards = generate_flashcards(topic, num_cards)
                
                # Process and structure flashcards
                self.flashcards = []
                self.categories = {}
                
                for i, card in enumerate(raw_cards):
                    if isinstance(card, dict):
                        # New structured format
                        flashcard = {
                            'question': card.get('question', ''),
                            'answer': card.get('answer', ''),
                            'category': card.get('category', 'General'),
                            'difficulty': card.get('difficulty', difficulty),
                            'hint': card.get('hint', ''),
                            'explanation': card.get('explanation', ''),
                            'topic': topic
                        }
                    else:
                        # Old format (question, answer tuple)
                        question_text = ''
                        answer_text = ''
                        if isinstance(card, (list, tuple)) and len(card) > 0:
                            question_text = str(card[0])
                        if isinstance(card, (list, tuple)) and len(card) > 1:
                            answer_text = str(card[1])
                        
                        flashcard = {
                            'question': question_text if question_text else str(card),
                            'answer': answer_text,
                            'category': 'General',
                            'difficulty': difficulty,
                            'hint': '',
                            'explanation': '',
                            'topic': topic
                        }
                    
                    self.flashcards.append(flashcard)
                    
                    # Update categories
                    category = flashcard['category']
                    if category not in self.categories:
                        self.categories[category] = []
                    self.categories[category].append(i)
                
                # Update UI in main thread
                self.root.after(0, self.on_flashcards_generated)
                
            except Exception as e:
                self.root.after(0, lambda: self.on_generation_error(str(e)))
        
        thread = threading.Thread(target=generate_thread)
        thread.daemon = True
        thread.start()

    def on_flashcards_generated(self):
        """Called when flashcards are successfully generated"""
        self.index = 0
        self.score = 0
        self.streak = 0
        self.review_cards = []
        self.session_history = []
        self.start_time = time.time()
        
        # Update category combo
        categories = ["all"] + list(self.categories.keys())
        self.category_combo['values'] = categories
        self.category_var.set("all")
        
        # Enable buttons and show first card
        self.generate_btn.config(state='normal', text="🎯 Generate Flashcards")
        self.show_card()
        self.update_stats()
        
        messagebox.showinfo("Success", f"Generated {len(self.flashcards)} flashcards!")

    def on_generation_error(self, error_msg):
        """Handle generation errors"""
        self.generate_btn.config(state='normal', text="🎯 Generate Flashcards")
        self.progress_label.config(text="Failed to generate flashcards")
        messagebox.showerror("Generation Error", f"Failed to generate flashcards:\n{error_msg}")

    def show_card(self):
        """Display current flashcard"""
        if self.index < len(self.flashcards):
            card = self.flashcards[self.index]
            
            # Clear and display question
            self.question_text.config(state='normal')
            self.question_text.delete(1.0, tk.END)
            self.question_text.insert(1.0, card['question'])
            self.question_text.config(state='disabled')
            
            # Clear answer and feedback
            self.answer_entry.delete(0, tk.END)
            self.feedback_text.config(state='normal')
            self.feedback_text.delete(1.0, tk.END)
            self.feedback_text.config(state='disabled')
            
            # Update labels
            self.category_label.config(text=f"📁 {card['category']}")
            self.difficulty_label.config(text=f"📊 {card['difficulty'].capitalize()}")
            
            # Update hint
            self.hint_var.set("")
            
            # Update progress
            progress = (self.index / len(self.flashcards)) * 100 if self.flashcards else 0
            self.progress_var.set(progress)
            self.progress_label.config(text=f"Card {self.index + 1} of {len(self.flashcards)}")
            self.progress_stats_label.config(text=f"{self.index + 1}/{len(self.flashcards)}")
            
            # Enable/disable buttons
            self.submit_btn.config(state='normal')
            self.show_answer_btn.config(state='normal')
            self.next_btn.config(state='disabled')
            self.hint_btn.config(state='normal' if card.get('hint') else 'disabled')
            
            # Focus on answer entry
            self.answer_entry.focus()
            
        else:
            self.show_completion()

    def show_hint(self):
        """Show hint for current card"""
        if self.index < len(self.flashcards):
            hint = self.flashcards[self.index].get('hint', '')
            if hint:
                self.hint_var.set(f"💡 Hint: {hint}")
                self.hint_btn.config(state='disabled')

    def show_answer(self):
        """Show the correct answer"""
        if self.index < len(self.flashcards):
            answer = self.flashcards[self.index]['answer']
            self.feedback_text.config(state='normal')
            self.feedback_text.delete(1.0, tk.END)
            self.feedback_text.insert(1.0, f"✅ Correct Answer: {answer}\n\n")
            
            # Add explanation if available
            explanation = self.flashcards[self.index].get('explanation', '')
            if explanation:
                self.feedback_text.insert(tk.END, f"📚 Explanation:\n{explanation}")
            
            self.feedback_text.config(state='disabled')
            self.next_btn.config(state='normal')

    def check_answer(self):
        """Check user's answer with semantic matching"""
        if self.index >= len(self.flashcards):
            return
            
        user_answer = self.answer_entry.get().strip()
        if not user_answer:
            messagebox.showwarning("Input Required", "Please enter an answer")
            return
        
        correct_answer = self.flashcards[self.index]['answer']
        question = self.flashcards[self.index]['question']
        
        # Show loading
        self.submit_btn.config(state='disabled', text="⏳ Evaluating...")
        
        # Run semantic match in separate thread
        def evaluate_thread():
            try:
                # Enhanced semantic match (should return structured response)
                match_result = semantic_match(user_answer, correct_answer)
                
                # Process result
                if isinstance(match_result, dict):
                    is_correct = match_result.get('is_correct', False)
                    feedback = match_result.get('feedback', '')
                    confidence = match_result.get('confidence', 0)
                else:
                    # Old boolean format
                    is_correct = match_result
                    feedback = "Correct!" if is_correct else "Incorrect!"
                    confidence = 1.0 if is_correct else 0.0
                
                # Update in main thread
                self.root.after(0, lambda: self.on_answer_evaluated(
                    is_correct, feedback, confidence, user_answer
                ))
                
            except Exception as e:
                self.root.after(0, lambda: self.on_evaluation_error(str(e)))
        
        thread = threading.Thread(target=evaluate_thread)
        thread.daemon = True
        thread.start()

    def on_answer_evaluated(self, is_correct, feedback, confidence, user_answer):
        """Handle answer evaluation result"""
        self.submit_btn.config(state='normal', text="✅ Submit Answer")
        
        card = self.flashcards[self.index]
        
        # Update score and streak
        if is_correct:
            self.score += 1
            self.streak += 1
            self.max_streak = max(self.max_streak, self.streak)
        else:
            self.streak = 0
            self.review_cards.append(self.index)
        
        # Add to history
        history_entry = {
            'question': card['question'],
            'user_answer': user_answer,
            'correct_answer': card['answer'],
            'is_correct': is_correct,
            'time': datetime.now().strftime("%H:%M:%S")
        }
        self.session_history.append(history_entry)
        
        # Update history listbox
        status = "✓" if is_correct else "✗"
        self.history_listbox.insert(0, f"{status} {user_answer[:30]}...")
        
        # Keep only last 10 entries
        if self.history_listbox.size() > 10:
            self.history_listbox.delete(10, tk.END)
        
        # Show feedback
        self.feedback_text.config(state='normal')
        self.feedback_text.delete(1.0, tk.END)
        
        if is_correct:
            self.feedback_text.insert(1.0, "✅ Correct!\n", 'correct')
        else:
            self.feedback_text.insert(1.0, "❌ Incorrect!\n", 'incorrect')
        
        self.feedback_text.insert(tk.END, f"📊 Confidence: {confidence:.0%}\n\n")
        self.feedback_text.insert(tk.END, f"🎯 Your answer: {user_answer}\n")
        self.feedback_text.insert(tk.END, f"✅ Correct answer: {card['answer']}\n\n")
        
        if feedback and isinstance(feedback, str):
            self.feedback_text.insert(tk.END, f"💡 Feedback: {feedback}\n")
        
        # Add explanation if available
        explanation = card.get('explanation', '')
        if explanation:
            self.feedback_text.insert(tk.END, f"\n📚 Explanation:\n{explanation}")
        
        self.feedback_text.tag_config('correct', foreground='green')
        self.feedback_text.tag_config('incorrect', foreground='red')
        self.feedback_text.config(state='disabled')
        
        # Update stats
        self.update_stats()
        
        # Enable next button
        self.next_btn.config(state='normal')

    def on_evaluation_error(self, error_msg):
        """Handle evaluation errors"""
        self.submit_btn.config(state='normal', text="✅ Submit Answer")
        messagebox.showerror("Evaluation Error", f"Failed to evaluate answer:\n{error_msg}")

    def next_card(self):
        """Move to next card"""
        if self.study_mode_var.get() == "review" and self.review_cards:
            # In review mode, cycle through incorrect cards
            self.index = (self.index + 1) % len(self.review_cards)
            actual_index = self.review_cards[self.index]
            # Find the card with actual_index in flashcards
            for i, card in enumerate(self.flashcards):
                if i == actual_index:
                    self.index = i
                    break
        else:
            self.index += 1
        
        self.show_card()

    def show_completion(self):
        """Show quiz completion screen"""
        self.question_text.config(state='normal')
        self.question_text.delete(1.0, tk.END)
        self.question_text.insert(1.0, "🎉 Quiz Complete! 🎉\n\n")
        
        accuracy = (self.score / len(self.flashcards)) * 100 if self.flashcards else 0
        time_spent = time.time() - (self.start_time if self.start_time else time.time())
        
        stats = f"""
        📊 Final Statistics:
        --------------------
        • Total Cards: {len(self.flashcards)}
        • Correct Answers: {self.score}
        • Accuracy: {accuracy:.1f}%
        • Max Streak: {self.max_streak}
        • Time Spent: {time_spent:.0f} seconds
        
        🎯 Performance:
        {'Excellent!' if accuracy >= 90 else 'Good job!' if accuracy >= 70 else 'Keep practicing!'}
        """
        
        self.question_text.insert(tk.END, stats)
        self.question_text.config(state='disabled')
        
        # Disable buttons
        self.submit_btn.config(state='disabled')
        self.show_answer_btn.config(state='disabled')
        self.next_btn.config(state='disabled')
        self.hint_btn.config(state='disabled')
        
        # Show completion message
        messagebox.showinfo("Quiz Complete", f"You scored {self.score}/{len(self.flashcards)}!\nAccuracy: {accuracy:.1f}%")

    def update_stats(self):
        """Update statistics display"""
        self.score_label.config(text=str(self.score))
        self.streak_label.config(text=str(self.streak))
        
        # Calculate accuracy
        attempted = self.index + 1 if self.flashcards else 1
        accuracy = (self.score / attempted) * 100
        self.accuracy_label.config(text=f"{accuracy:.1f}%")

    def update_timer(self):
        """Update the timer display"""
        # Check if timer_label exists (it may not during initial setup)
        if hasattr(self, 'timer_label') and self.timer_label is not None:
            if self.start_time:
                elapsed = time.time() - self.start_time
                minutes = int(elapsed // 60)
                seconds = int(elapsed % 60)
                self.timer_label.config(text=f"{minutes:02d}:{seconds:02d}")
        
        # Schedule next update
        self.root.after(1000, self.update_timer)

    def save_session(self):
        """Save current session to file"""
        if not self.flashcards:
            messagebox.showwarning("No Session", "No flashcards to save")
            return
        
        filename = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")]
        )
        
        if filename:
            session_data = {
                'flashcards': self.flashcards,
                'index': self.index,
                'score': self.score,
                'streak': self.streak,
                'max_streak': self.max_streak,
                'review_cards': self.review_cards,
                'session_history': self.session_history,
                'topic': self.topic_entry.get(),
                'timestamp': datetime.now().isoformat()
            }
            
            try:
                with open(filename, 'w') as f:
                    json.dump(session_data, f, indent=2)
                messagebox.showinfo("Success", "Session saved successfully!")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to save session: {e}")

    def load_session_file(self):
        """Load session from file"""
        filename = filedialog.askopenfilename(
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")]
        )
        
        if filename:
            try:
                with open(filename, 'r') as f:
                    session_data = json.load(f)
                
                self.flashcards = session_data['flashcards']
                self.index = session_data['index']
                self.score = session_data['score']
                self.streak = session_data['streak']
                self.max_streak = session_data.get('max_streak', 0)
                self.review_cards = session_data.get('review_cards', [])
                self.session_history = session_data.get('session_history', [])
                
                # Update UI
                self.topic_entry.delete(0, tk.END)
                self.topic_entry.insert(0, session_data.get('topic', ''))
                
                # Rebuild categories
                self.categories = {}
                for i, card in enumerate(self.flashcards):
                    category = card.get('category', 'General')
                    if category not in self.categories:
                        self.categories[category] = []
                    self.categories[category].append(i)
                
                # Update category combo
                categories = ["all"] + list(self.categories.keys())
                self.category_combo['values'] = categories
                self.category_var.set("all")
                
                self.show_card()
                self.update_stats()
                messagebox.showinfo("Success", "Session loaded successfully!")
                
            except Exception as e:
                messagebox.showerror("Error", f"Failed to load session: {e}")

    def load_session(self):
        """Load previous session from default location"""
        try:
            if os.path.exists('last_session.json'):
                with open('last_session.json', 'r') as f:
                    session_data = json.load(f)
                
                # Just load the topic for convenience
                topic = session_data.get('topic', '')
                if topic:
                    self.topic_entry.delete(0, tk.END)
                    self.topic_entry.insert(0, topic)
        except:
            pass  # Ignore errors when loading last session

    def show_analytics(self):
        """Show detailed analytics window"""
        analytics_window = tk.Toplevel(self.root)
        analytics_window.title("📈 Detailed Analytics")
        analytics_window.geometry("800x600")
        
        # Configure grid for toplevel window
        analytics_window.columnconfigure(0, weight=1)
        analytics_window.rowconfigure(0, weight=1)
        
        # Create notebook for tabs
        notebook = ttk.Notebook(analytics_window)
        notebook.grid(row=0, column=0, sticky="nsew", padx=10, pady=10)
        
        # Performance tab
        perf_frame = ttk.Frame(notebook)
        perf_frame.columnconfigure(0, weight=1)
        perf_frame.rowconfigure(0, weight=1)
        notebook.add(perf_frame, text="Performance")
        
        perf_text = scrolledtext.ScrolledText(perf_frame, wrap=tk.WORD)
        perf_text.grid(row=0, column=0, sticky="nsew", padx=10, pady=10)
        
        # Calculate statistics
        total = len(self.flashcards)
        attempted = self.index
        accuracy = (self.score / attempted * 100) if attempted > 0 else 0
        
        stats = f"""
        📊 Detailed Performance Report
        {'=' * 40}
        
        Session Information:
        • Topic: {self.topic_entry.get() or 'N/A'}
        • Total Cards: {total}
        • Cards Attempted: {attempted}
        • Completion: {(attempted/total*100):.1f}% if total > 0 else 0
        
        Accuracy Statistics:
        • Correct Answers: {self.score}
        • Accuracy Rate: {accuracy:.1f}%
        • Current Streak: {self.streak}
        • Best Streak: {self.max_streak}
        
        Time Statistics:
        • Time Started: {datetime.fromtimestamp(self.start_time).strftime('%H:%M:%S') if self.start_time else 'N/A'}
        • Current Time: {datetime.now().strftime('%H:%M:%S')}
        
        Category Breakdown:
        """
        
        # Add category breakdown
        for category, indices in self.categories.items():
            category_cards = len(indices)
            stats += f"• {category}: {category_cards} cards\n"
        
        perf_text.insert(1.0, stats)
        perf_text.config(state='disabled')
        
        # History tab
        history_frame = ttk.Frame(notebook)
        history_frame.columnconfigure(0, weight=1)
        history_frame.rowconfigure(0, weight=1)
        notebook.add(history_frame, text="Answer History")
        
        history_text = scrolledtext.ScrolledText(history_frame, wrap=tk.WORD)
        history_text.grid(row=0, column=0, sticky="nsew", padx=10, pady=10)
        
        history_content = "📝 Answer History\n" + "=" * 40 + "\n\n"
        for i, entry in enumerate(reversed(self.session_history[-20:]), 1):
            status = "✓" if entry['is_correct'] else "✗"
            history_content += f"{i}. {status} {entry['time']}\n"
            history_content += f"   Q: {entry['question'][:50]}...\n"
            history_content += f"   Your answer: {entry['user_answer']}\n"
            history_content += f"   Correct answer: {entry['correct_answer']}\n"
            history_content += "-" * 40 + "\n"
        
        history_text.insert(1.0, history_content)
        history_text.config(state='disabled')

    def reset_session(self):
        """Reset current session"""
        if messagebox.askyesno("Reset Session", "Are you sure you want to reset the current session?"):
            self.flashcards = []
            self.index = 0
            self.score = 0
            self.streak = 0
            self.max_streak = 0
            self.review_cards = []
            self.session_history = []
            self.categories = {}
            
            # Reset UI
            self.question_text.config(state='normal')
            self.question_text.delete(1.0, tk.END)
            self.question_text.config(state='disabled')
            
            self.feedback_text.config(state='normal')
            self.feedback_text.delete(1.0, tk.END)
            self.feedback_text.config(state='disabled')
            
            self.answer_entry.delete(0, tk.END)
            self.hint_var.set("")
            
            self.progress_var.set(0)
            self.progress_label.config(text="Ready to learn!")
            
            self.category_label.config(text="")
            self.difficulty_label.config(text="")
            
            self.update_stats()
            self.history_listbox.delete(0, tk.END)
            
            # Reset start time
            self.start_time = time.time()

    def review_mistakes(self):
        """Start review mode for incorrect answers"""
        if not self.review_cards:
            messagebox.showinfo("No Mistakes", "You haven't made any mistakes yet!")
            return
        
        self.study_mode_var.set("review")
        self.index = 0
        self.show_card()
        messagebox.showinfo("Review Mode", f"Reviewing {len(self.review_cards)} incorrect answers")

    def on_closing(self):
        """Handle window closing"""
        # Save current topic
        if self.topic_entry.get():
            try:
                session_data = {
                    'topic': self.topic_entry.get(),
                    'timestamp': datetime.now().isoformat()
                }
                with open('last_session.json', 'w') as f:
                    json.dump(session_data, f, indent=2)
            except:
                pass
        
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    app = scriptShade(root)
    
    # Handle window closing
    root.protocol("WM_DELETE_WINDOW", app.on_closing)
    
    # Center window
    root.update_idletasks()
    width = root.winfo_width()
    height = root.winfo_height()
    x = (root.winfo_screenwidth() // 2) - (width // 2)
    y = (root.winfo_screenheight() // 2) - (height // 2)
    root.geometry(f'{width}x{height}+{x}+{y}')
    
    root.mainloop()