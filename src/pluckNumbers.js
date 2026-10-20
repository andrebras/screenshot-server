module.exports = function pluckNumbers(object, ...keys) {
  return keys.reduce((numbers, k) => {
    numbers[k] = safelyCastNumber(object[k]);
    return numbers;
  }, {});
};

function safelyCastNumber(string) {
  const number = Number(string);
  return isNaN(number) ? undefined : number;
}
