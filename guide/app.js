import { applyStoredTheme, mountThemeToggle } from '../shared/theme.js';

applyStoredTheme();
mountThemeToggle();

const treeFeedback = document.querySelector('#sample-tree-feedback');
const choiceFeedback = document.querySelector('#sample-choice-feedback');

const treeNotes = {
  root: 'This is the sample root: the page where a session begins. It is depth 0.',
  requirements: 'This sample page is one recorded link step from the root. That describes route distance, not usefulness.',
  tuition: '“Compare tuition details” is two recorded link steps from the root. Depth counts navigation steps; it does not judge the page.',
  scholarships: 'This is another branch from the root. A different branch is not automatically a detour.'
};

const choiceNotes = {
  continue: 'In the real extension, the card closes and the current page stays open so you can keep exploring.',
  return: 'In the real extension, this asks Intent Grove to return to the page where your intention session began.',
  save: 'In the real extension, the current page is added to your local Save for Later list.',
  new: 'In the real extension, this ends the current garden and opens the extension page where you can set another intention.',
  page: 'In the real extension, this starts a new garden using the page you are viewing as its starting point.'
};

for (const button of document.querySelectorAll('[data-sample-node]')) {
  button.addEventListener('click', () => {
    for (const node of document.querySelectorAll('[data-sample-node]')) {
      node.setAttribute('aria-pressed', String(node === button));
    }
    treeFeedback.textContent = treeNotes[button.dataset.sampleNode];
  });
}

for (const button of document.querySelectorAll('[data-sample-choice]')) {
  button.addEventListener('click', () => {
    for (const choice of document.querySelectorAll('[data-sample-choice]')) {
      choice.setAttribute('aria-pressed', String(choice === button));
    }
    choiceFeedback.textContent = choiceNotes[button.dataset.sampleChoice];
  });
}
