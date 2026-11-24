const authorize = document.getElementById("authorize");
if (authorize) {
  const form = authorize.form;
  function updateSelection() {
    authorize.disabled = !form.querySelector('input[name="number"]:checked');
  }
  form.addEventListener("change", updateSelection);
  window.addEventListener("pageshow", updateSelection);
  updateSelection();
}
