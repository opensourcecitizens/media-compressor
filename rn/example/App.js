import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet } from 'react-native';
import QueryMedia from './components/QueryMedia';
import UploadMedia from './components/UploadMedia';

export default function App() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <StatusBar style="auto" />
      <UploadMedia />
      <QueryMedia />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { paddingTop: 48 },
});
