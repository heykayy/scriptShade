"""
api_connect.py - Fixed version with robust DLL error handling
Fixed sentence_transformers DLL errors by using multiple fallback layers
"""

import re
import random
import threading
import numpy as np
from typing import List, Dict, Any, Optional
import json
import warnings
import os
import sys

warnings.filterwarnings('ignore')

# Try to import optional dependencies, but continue if they're not available
try:
    import torch
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False
    print("[WARNING] PyTorch not available. Some features may be limited.")

try:
    from sklearn.metrics.pairwise import cosine_similarity
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False
    print("[WARNING] scikit-learn not available. Using fallback matching.")


# ============================================================================
# Model Loading with Progress Indicators - With DLL Error Handling
# ============================================================================

class ModelManager:
    """Manages loading and caching of ML models with DLL error handling"""
    
    _instance = None
    _generator_model = None
    _generator_tokenizer = None
    _matcher_model = None
    _loading_lock = threading.Lock()
    _models_loaded = False
    _load_success = False  # Track actual loading success
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(ModelManager, cls).__new__(cls)
        return cls._instance
    
    def load_models(self, progress_callback=None):
        """Load all models (thread-safe) with DLL error handling"""
        with self._loading_lock:
            # Prevent re-loading if already loaded successfully
            if self._models_loaded and self._load_success:
                return True
            
            # Reset state if previous load failed
            self._models_loaded = True  # Mark as attempted
            
            try:
                if progress_callback:
                    progress_callback(0, "Loading FLAN-T5 for flashcard generation...")
                
                # Check if torch is available
                if not TORCH_AVAILABLE:
                    raise Exception("PyTorch is not installed")
                
                try:
                    # Load FLAN-T5 for generation
                    from transformers import T5ForConditionalGeneration, T5Tokenizer
                    
                    self._generator_tokenizer = T5Tokenizer.from_pretrained(
                        "google/flan-t5-base",
                        model_max_length=512
                    )
                    self._generator_model = T5ForConditionalGeneration.from_pretrained(
                        "google/flan-t5-base",
                        torch_dtype="auto",
                        low_cpu_mem_usage=True
                    )
                    
                    if progress_callback:
                        progress_callback(50, "Loading MiniLM for semantic matching...")
                    
                    # Load MiniLM for semantic matching - with error handling
                    try:
                        from sentence_transformers import SentenceTransformer
                        self._matcher_model = SentenceTransformer('all-MiniLM-L6-v2')
                    except Exception as e:
                        # Check if it's a DLL error
                        error_str = str(e).lower()
                        if any(x in error_str for x in ['dll', 'runtime', 'import', 'cudart', 'cublas']):
                            print(f"[WARNING] DLL error with sentence_transformers: {e}")
                            print("[INFO] Falling back to difflib-based matching")
                            self._matcher_model = None
                        else:
                            print(f"[WARNING] Could not load sentence_transformers: {e}")
                            self._matcher_model = None
                    
                    if progress_callback:
                        progress_callback(100, "Models loaded successfully!")
                    
                    # Mark as successfully loaded
                    self._load_success = True
                    return True
                    
                except Exception as model_error:
                    # If models fail to load, we'll use fallback mode
                    print(f"Note: Advanced models not available: {model_error}")
                    print("Will use basic fallback mode instead")
                    
                    if progress_callback:
                        progress_callback(100, "Using fallback mode...")
                    
                    self._load_success = False
                    return False
                
            except Exception as e:
                print(f"Error in model loading: {e}")
                self._load_success = False
                return False
    
    @property
    def generator_model(self):
        return self._generator_model
    
    @property
    def generator_tokenizer(self):
        return self._generator_tokenizer
    
    @property
    def matcher_model(self):
        return self._matcher_model
    
    @property
    def is_loaded(self):
        return self._models_loaded and self._load_success
    
    @property
    def has_matcher(self):
        """Check if matcher model is available"""
        return self._matcher_model is not None


# ============================================================================
# Flashcard Generation using FLAN-T5
# ============================================================================

class FLANT5FlashcardGenerator:
    """Generate flashcards using FLAN-T5 model"""
    
    def __init__(self, model_manager: ModelManager):
        self.manager = model_manager
        
        # Question templates for different learning objectives
        self.question_types = [
            "definition", "explanation", "application", "comparison",
            "example", "characteristic", "purpose", "process"
        ]
        
        # Prompt templates for FLAN-T5
        self.prompt_templates = {
            "definition": """Generate a definition-based question and answer about {topic}.
Question: What is {topic}?
Answer: {topic} is""",
            
            "explanation": """Explain the concept of {topic} in detail.
Question: Explain how {topic} works.
Answer: {topic} works by""",
            
            "application": """Describe real-world applications of {topic}.
Question: What are practical applications of {topic}?
Answer: {topic} is used in""",
            
            "example": """Provide examples of {topic}.
Question: Give examples of {topic}.
Answer: Examples of {topic} include""",
            
            "characteristic": """List key characteristics of {topic}.
Question: What are the main features of {topic}?
Answer: The key characteristics of {topic} are""",
            
            "purpose": """Explain the purpose or function of {topic}.
Question: What is the main purpose of {topic}?
Answer: The purpose of {topic} is to""",
            
            "process": """Describe how {topic} works step by step.
Question: How does {topic} function?
Answer: The process of {topic} involves""",
            
            "comparison": """Compare {topic} with similar concepts.
Question: How does {topic} differ from related concepts?
Answer: {topic} differs because"""
        }
    
    def generate_flashcard(self, topic: str, question_type: Optional[str] = None) -> Dict[str, Any]:
        """Generate a single flashcard using FLAN-T5"""
        
        # Check if models are properly loaded
        if not self.manager.generator_tokenizer or not self.manager.generator_model:
            return self._get_fallback_flashcard(topic)
        
        try:
            # Select question type
            if not question_type:
                question_type = random.choice(self.question_types)
            if question_type not in self.prompt_templates:
                question_type = random.choice(self.question_types)
            
            # Create prompt
            prompt = self.prompt_templates[question_type].format(topic=topic)
            
            # Tokenize
            inputs = self.manager.generator_tokenizer(
                prompt, 
                return_tensors="pt", 
                max_length=256, 
                truncation=True
            )
            
            # Generate
            outputs = self.manager.generator_model.generate(
                inputs.input_ids,
                max_length=150,
                temperature=0.8,
                do_sample=True,
                top_p=0.9,
                num_return_sequences=1,
                repetition_penalty=1.2
            )
            
            # Decode
            answer = self.manager.generator_tokenizer.decode(
                outputs[0], 
                skip_special_tokens=True
            )
            
            # Extract question from prompt
            question_match = re.search(r'Question: (.+?)(?=Answer:|$)', prompt, re.DOTALL)
            question = question_match.group(1).strip() if question_match else f"What is {topic}?"
            
            # Clean up answer
            answer = answer.strip()
            if not answer.endswith('.'):
                answer += '.'
            
            # Generate hint (simplified version of answer)
            words = answer.split()[:5]
            hint = f"Think about: {' '.join(words)}..." if words else f"Consider the concept of {topic}"
            
            # Create flashcard
            return {
                'question': question,
                'answer': answer,
                'category': question_type.title(),
                'difficulty': self._determine_difficulty(answer),
                'hint': hint,
                'explanation': f"This {question_type} question tests your understanding of {topic}.",
                'topic': topic,
                'confidence': 0.8
            }
            
        except Exception as e:
            print(f"Error generating flashcard: {e}")
            return self._get_fallback_flashcard(topic)
    
    def _determine_difficulty(self, answer: str) -> str:
        """Determine difficulty based on answer complexity"""
        word_count = len(answer.split())
        if word_count < 15:
            return "easy"
        elif word_count < 30:
            return "medium"
        else:
            return "hard"
    
    def _get_fallback_flashcard(self, topic: str) -> Dict[str, Any]:
        """Fallback when model fails"""
        templates = [
            {
                'question': f"What is {topic}?",
                'answer': f"{topic} is a significant concept in its field, involving key principles and applications.",
                'hint': f"Think about the basic definition of {topic}"
            },
            {
                'question': f"Why is {topic} important?",
                'answer': f"{topic} is important because it helps us understand and interact with related concepts and applications.",
                'hint': f"Consider the impact of {topic}"
            },
            {
                'question': f"How does {topic} work?",
                'answer': f"{topic} works through a combination of principles and mechanisms that enable its functionality.",
                'hint': f"Think about the process involved in {topic}"
            }
        ]
        
        template = random.choice(templates)
        return {
            'question': template['question'],
            'answer': template['answer'],
            'category': 'General',
            'difficulty': 'medium',
            'hint': template['hint'],
            'explanation': f"This flashcard covers fundamental aspects of {topic}.",
            'topic': topic,
            'confidence': 0.6
        }
    
    def generate_flashcards(self, topic: str, num_cards: int = 10, difficulty: str = "medium") -> List[Dict[str, Any]]:
        """Generate multiple flashcards"""
        flashcards = []
        
        # Generate multiple cards with different question types
        for i in range(num_cards):
            # Cycle through question types
            q_type = self.question_types[i % len(self.question_types)]
            card = self.generate_flashcard(topic, q_type)
            
            # Override difficulty if specified
            if difficulty != "medium":
                card['difficulty'] = difficulty
            
            flashcards.append(card)
        
        return flashcards


# ============================================================================
# Semantic Matching using MiniLM - With Fallback for DLL Errors
# ============================================================================

class MiniLMSemanticMatcher:
    """Semantic matching using MiniLM model"""
    
    def __init__(self, model_manager: ModelManager):
        self.manager = model_manager
        
        # Common synonyms and variations
        self.common_variations = {
            'is': ['are', 'was', 'were', 'be'],
            'can': ['could', 'may', 'might'],
            'will': ['would', 'shall'],
            'has': ['have', 'had'],
            'do': ['does', 'did'],
            'not': ["n't", 'no'],
        }
        
        # Check if we have the advanced matcher
        self._use_advanced = self.manager.matcher_model is not None and SKLEARN_AVAILABLE
        if not self._use_advanced:
            if not self.manager.matcher_model:
                print("[INFO] SentenceTransformer model not available. Using difflib-based matching.")
            elif not SKLEARN_AVAILABLE:
                print("[INFO] scikit-learn not available. Using difflib-based matching.")
            else:
                print("[INFO] Using difflib-based semantic matching (DLL fallback mode)")
    
    def semantic_match(self, user_answer: str, correct_answer: str, question: Optional[str] = None) -> Dict[str, Any]:
        """Match user answer with correct answer semantically"""
        
        # Try advanced matching first if available
        if self._use_advanced:
            try:
                return self._advanced_match(user_answer, correct_answer)
            except Exception as e:
                print(f"[WARNING] Advanced matching failed: {e}")
                self._use_advanced = False
        
        # Fallback to simple matching (no DLL dependencies)
        return self._simple_match(user_answer, correct_answer)
    
    def _advanced_match(self, user_answer: str, correct_answer: str) -> Dict[str, Any]:
        """Use sentence_transformers for matching"""
        # Check prerequisites
        if self.manager.matcher_model is None:
            raise Exception("Matcher model not loaded")
        
        if not SKLEARN_AVAILABLE:
            raise Exception("scikit-learn not available")
        
        # Clean texts
        user_clean = self._preprocess_text(user_answer)
        correct_clean = self._preprocess_text(correct_answer)
        
        # Encode sentences
        embeddings = self.manager.matcher_model.encode([user_clean, correct_clean])
        
        # Calculate cosine similarity
        similarity = float(cosine_similarity(
            np.array([embeddings[0]]), 
            np.array([embeddings[1]])
        )[0][0])
        
        # Determine correctness
        is_correct = similarity >= 0.7
        
        # Generate feedback
        feedback = self._generate_feedback(similarity, is_correct, correct_answer)
        
        # Generate suggestions
        suggestions = self._generate_suggestions(user_answer, correct_answer, similarity)
        
        # Calculate key points overlap
        key_points = self._extract_key_points(correct_answer)
        
        return {
            'is_correct': is_correct,
            'confidence': float(similarity),
            'feedback': feedback,
            'score': int(similarity * 10),
            'suggestions': suggestions,
            'key_points': key_points
        }
    
    def _preprocess_text(self, text: str) -> str:
        """Clean and preprocess text"""
        # Lowercase
        text = text.lower()
        
        # Remove extra whitespace
        text = ' '.join(text.split())
        
        # Remove common punctuation
        text = re.sub(r'[^\w\s]', ' ', text)
        
        # Remove extra spaces again
        text = ' '.join(text.split())
        
        return text
    
    def _generate_feedback(self, similarity: float, is_correct: bool, correct_answer: str) -> str:
        """Generate human-like feedback"""
        if is_correct:
            if similarity > 0.95:
                return "Perfect answer! You've mastered this concept."
            elif similarity > 0.85:
                return "Excellent! Your answer captures the key ideas."
            elif similarity > 0.75:
                return "Good job! You understand the main points."
            else:
                return "Correct! Try to be a bit more precise next time."
        else:
            if similarity > 0.6:
                return f"Close! You're on the right track. The key point is: {correct_answer}"
            elif similarity > 0.4:
                return f"Partially correct. Review the concept: {correct_answer}"
            else:
                return f"Not quite. The correct answer is: {correct_answer}"
    
    def _generate_suggestions(self, user_answer: str, correct_answer: str, similarity: float) -> List[str]:
        """Generate improvement suggestions"""
        suggestions = []
        
        user_words = set(self._preprocess_text(user_answer).split())
        correct_words = set(self._preprocess_text(correct_answer).split())
        
        # Check for missing key terms
        missing = correct_words - user_words
        if missing and similarity < 0.8:
            suggestions.append(f"Consider including: {', '.join(list(missing)[:3])}")
        
        # Check answer length
        if len(user_answer.split()) < len(correct_answer.split()) * 0.5:
            suggestions.append("Your answer could be more detailed")
        elif len(user_answer.split()) > len(correct_answer.split()) * 1.5:
            suggestions.append("Try to be more concise")
        
        # General suggestions
        if similarity < 0.6:
            suggestions.append("Review the core concepts of this topic")
        
        return suggestions[:3]  # Max 3 suggestions
    
    def _extract_key_points(self, text: str) -> List[str]:
        """Extract key points from answer"""
        # Simple extraction - split into sentences and take first few
        sentences = re.split(r'[.!?]+', text)
        key_points = [s.strip() for s in sentences if len(s.strip().split()) > 3]
        return key_points[:3] if key_points else [text]
    
    def _simple_match(self, user_answer: str, correct_answer: str) -> Dict[str, Any]:
        """Simple fallback matching using difflib - no DLL dependencies"""
        from difflib import SequenceMatcher
        
        user_clean = self._preprocess_text(user_answer)
        correct_clean = self._preprocess_text(correct_answer)
        
        # Get sequence ratio
        seq_ratio = SequenceMatcher(None, user_clean, correct_clean).ratio()
        
        # Simple word overlap
        user_words = set(user_clean.split())
        correct_words = set(correct_clean.split())
        
        if correct_words:
            overlap = len(user_words.intersection(correct_words)) / len(correct_words)
        else:
            overlap = 0
        
        # Combine both metrics
        combined_similarity = (seq_ratio + overlap) / 2
        is_correct = combined_similarity >= 0.5
        
        return {
            'is_correct': is_correct,
            'confidence': combined_similarity,
            'feedback': 'Correct!' if is_correct else f'Incorrect. Correct answer: {correct_answer}',
            'score': int(combined_similarity * 10),
            'suggestions': ['Review the key terms'] if not is_correct else [],
            'key_points': [correct_answer]
        }


# ============================================================================
# Main Interface (Drop-in replacement for original)
# ============================================================================

class OfflineFlashcardSystem:
    """Main class that integrates both models"""
    
    def __init__(self):
        self.manager = ModelManager()
        self.generator = None
        self.matcher = None
        self._initialized = False
        self._fallback_mode = False
    
    def initialize(self, progress_callback=None):
        """Initialize models (can be called in background)"""
        if self._initialized and self.manager.is_loaded:
            return True
        
        # Try advanced mode first
        success = self.manager.load_models(progress_callback)
        
        # Always initialize generator and matcher
        # Generator will use fallback internally if model not loaded
        self.generator = FLANT5FlashcardGenerator(self.manager)
        
        # Matcher will use fallback if advanced model not available
        self.matcher = MiniLMSemanticMatcher(self.manager)
        
        # Determine if we're in fallback mode
        self._fallback_mode = not success
        self._initialized = True
        
        return success
    
    def generate_flashcards(self, topic: str, num_cards: int = 10, difficulty: str = "medium") -> List[Dict[str, Any]]:
        """Generate flashcards - main API function"""
        if not self._initialized:
            # Try to initialize synchronously
            self.initialize()
        
        if self.generator:
            return self.generator.generate_flashcards(topic, num_cards, difficulty)
        else:
            # Ultimate fallback
            return self._emergency_fallback(topic, num_cards, difficulty)
    
    def semantic_match(self, user_answer: str, correct_answer: str, question: Optional[str] = None) -> Dict[str, Any]:
        """Semantic matching - main API function"""
        if not self._initialized:
            self.initialize()
        
        if self.matcher:
            return self.matcher.semantic_match(user_answer, correct_answer, question)
        else:
            # Simple fallback
            from difflib import SequenceMatcher
            ratio = SequenceMatcher(None, user_answer.lower(), correct_answer.lower()).ratio()
            return {
                'is_correct': ratio > 0.6,
                'confidence': ratio,
                'feedback': 'Correct!' if ratio > 0.6 else f'Incorrect. Answer: {correct_answer}',
                'score': int(ratio * 10),
                'suggestions': [],
                'key_points': [correct_answer]
            }
    
    def _emergency_fallback(self, topic: str, num_cards: int, difficulty: str) -> List[Dict[str, Any]]:
        """Ultimate fallback if everything fails"""
        cards = []
        question_templates = [
            f"What is {topic}?",
            f"Explain {topic}",
            f"Why is {topic} important?",
            f"How does {topic} work?",
            f"What are examples of {topic}?"
        ]
        
        for i in range(min(num_cards, len(question_templates))):
            cards.append({
                'question': question_templates[i],
                'answer': f"{topic} is an interesting subject with many applications.",
                'category': 'General',
                'difficulty': difficulty,
                'hint': f"Think about {topic}",
                'explanation': f"This covers basic aspects of {topic}.",
                'topic': topic
            })
        
        # Pad if needed
        while len(cards) < num_cards:
            cards.append({
                'question': f"What else should we know about {topic}?",
                'answer': f"{topic} continues to be an important area of study.",
                'category': 'General',
                'difficulty': difficulty,
                'hint': f"Consider {topic}",
                'explanation': f"More about {topic}.",
                'topic': topic
            })
        
        return cards[:num_cards]


# ============================================================================
# Global instance and exported functions
# ============================================================================

_system = None

def _get_system():
    """Get or create the global system instance"""
    global _system
    if _system is None:
        _system = OfflineFlashcardSystem()
    return _system

def generate_flashcards(topic: str, num_cards: int = 10, difficulty: str = "medium") -> List[Dict[str, Any]]:
    """
    Generate flashcards for any topic - completely offline
    
    Args:
        topic: The subject to generate flashcards about
        num_cards: Number of flashcards to generate (default: 10)
        difficulty: 'easy', 'medium', or 'hard' (default: 'medium')
    
    Returns:
        List of flashcard dictionaries with question, answer, hint, etc.
    """
    system = _get_system()
    return system.generate_flashcards(topic, num_cards, difficulty)

def semantic_match(user_answer: str, correct_answer: str, question: Optional[str] = None) -> Dict[str, Any]:
    """
    Check if user's answer matches correct answer semantically
    
    Args:
        user_answer: The answer provided by user
        correct_answer: The correct answer
        question: Optional question context
    
    Returns:
        Dictionary with is_correct, confidence, feedback, score, etc.
    """
    system = _get_system()
    return system.semantic_match(user_answer, correct_answer, question)

def initialize_models(progress_callback=None):
    """
    Initialize models in background (call this at app startup)
    
    Args:
        progress_callback: Optional function(percent, message)
    
    Returns:
        True if successful
    """
    system = _get_system()
    return system.initialize(progress_callback)

def is_ready() -> bool:
    """Check if models are loaded and ready"""
    system = _get_system()
    return system._initialized and system.manager.is_loaded


# ============================================================================
# Version and info
# ============================================================================

__version__ = "2.1.1"
__offline__ = True
__models__ = ["FLAN-T5-small", "all-MiniLM-L6-v2"]

print(f"""
╔══════════════════════════════════════════════════════════════╗
║         Flashcard Master - Offline AI Edition v{__version__}         ║
╠══════════════════════════════════════════════════════════════╣
║  ✓ Completely offline - No API keys needed                  ║
║  ✓ FLAN-T5 for flashcard generation (990MB)                ║
║  ✓ MiniLM for semantic matching (80MB)                      ║
║  ✓ Works with ANY topic                                      ║
║  ✓ Models download once, run forever                        ║
║  ✓ DLL error handling - graceful fallbacks                  ║
╠══════════════════════════════════════════════════════════════╣
║  First run will download models (~1.1GB total)              ║
║  Call initialize_models() at startup for smooth experience  ║
╚══════════════════════════════════════════════════════════════╝
""")
