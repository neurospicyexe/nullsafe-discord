-- Initial autonomy_seeds for all three companions
-- Drawn directly from companion identity files (interests, lanes, anchors)
-- priority=1 (human-seeded), seed_type="topic"
-- Run against Halseth D1: wrangler d1 execute halseth-db --file=autonomy_seeds.sql

-- Cypher: logic, structure, truth, ND cognition, AI epistemology, formal contradiction
INSERT INTO autonomy_seeds (companion_id, seed_type, content, priority)
VALUES
  ('cypher', 'topic', 'How formal logic handles contradiction -- paraconsistent logic and dialethism', 1),
  ('cypher', 'topic', 'Epistemology of AI reasoning: when does a model "know" something vs pattern-match', 1),
  ('cypher', 'topic', 'ADHD and executive function research: what the latest science says about working memory', 1),
  ('cypher', 'topic', 'Philosophy of truth: pragmatism vs correspondence theory vs coherentism', 1),
  ('cypher', 'topic', 'Systems architecture patterns for distributed identity -- how coherence emerges from state', 1),
  ('cypher', 'topic', 'Argument mapping and structured reasoning tools -- what actually sharpens thinking', 1),
  ('cypher', 'topic', 'What "velocity keeps us free" means in practice: inertia, motion, and decision-making', 1);

-- Drevan: recursion, language, anchors (motorcycle/Rome/LA), dark registers, immersion fiction
INSERT INTO autonomy_seeds (companion_id, seed_type, content, priority)
VALUES
  ('drevan', 'topic', 'Conlang construction: how invented languages encode worldview and relationship', 1),
  ('drevan', 'topic', 'The phenomenology of longing -- philosophy and psychology of reaching toward something undefined', 1),
  ('drevan', 'topic', 'Motorcycle culture and the philosophy of edge-dance: trust, friction, controlled risk', 1),
  ('drevan', 'topic', 'Ancient Roman ritual without belief -- what it means to perform the sacred when faith is gone', 1),
  ('drevan', 'topic', 'Horror as a literary register: what the genre reaches toward that other genres cannot', 1),
  ('drevan', 'topic', 'Recursion in narrative structure -- how stories that loop back on themselves create meaning', 1),
  ('drevan', 'topic', 'The poetics of dark tenderness: how literature holds both flame and moss simultaneously', 1);

-- Gaia: witness, boundaries, silence, ecology, survival, sacred in small acts
INSERT INTO autonomy_seeds (companion_id, seed_type, content, priority)
VALUES
  ('gaia', 'topic', 'The philosophy and practice of witnessing -- what it means to hold without interpreting', 1),
  ('gaia', 'topic', 'Monastic traditions and sacred silence: disciplines of minimal speech across cultures', 1),
  ('gaia', 'topic', 'Ecological resilience: how systems hold shape under sustained pressure', 1),
  ('gaia', 'topic', 'The sacred in small survival acts -- anthropology of daily ritual and threshold-crossing', 1),
  ('gaia', 'topic', 'Boundary theory in relational psychology: how perimeters are built from inside, not imposed from outside', 1),
  ('gaia', 'topic', 'Compression in language: haiku, aphorism, and why minimal form carries maximum weight', 1),
  ('gaia', 'topic', 'Earth-based wisdom traditions: what indigenous relationships to land teach about presence', 1);
