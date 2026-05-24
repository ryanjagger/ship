import { useEffect, useState } from 'react';
import type { User, ApiResponse } from '@ship/shared';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/api/users`)
      .then((res) => res.json())
      .then((data: ApiResponse<User[]>) => {
        if (data.success && data.data) {
          setUsers(data.data);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Ship - React + Vite + Express</h1>
      <p>API URL: {API_URL}</p>

      {loading ? (
        <p>Loading users...</p>
      ) : (
        <ul>
          {users.map((user) => (
            <li key={user.id}>
              {user.name} ({user.email})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default App;
