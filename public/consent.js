const authorize = document.getElementById("authorize");
if (authorize) {
  const form = authorize.form;
  let submitting = false;
  form.addEventListener("submit", (event) => {
    if (submitting) event.preventDefault();
    submitting = true;
  });
  function updateSelection() {
    authorize.disabled = !form.querySelector('input[name="number"]:checked');
  }
  form.addEventListener("change", updateSelection);
  window.addEventListener("pageshow", () => {
    submitting = false;
    updateSelection();
  });
  updateSelection();
}
