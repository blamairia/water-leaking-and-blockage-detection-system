import requests

BASE_URL = 'http://localhost:5000/api/data'
params = {
    'table': 'flowRates',
    'metric': 'flowRate1,flowRate2,flowRate3,totalVolume',
    'limit': 10,
    'offset': 0,
    'startTime': '2023-01-01T00:00:00Z',
    'endTime': '2024-12-31T23:59:59Z'
}

response = requests.get(BASE_URL, params=params)
if response.status_code == 200:
    print(response.json())
else:
    print(f'Failed to fetch data: {response.status_code}')
