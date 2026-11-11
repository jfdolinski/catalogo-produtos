import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Api } from './api';
import { cores } from './ui';

/**
 * Campo de texto que sugere os valores já cadastrados no catálogo (marca, categoria), enquanto digita.
 * Tocar numa sugestão preenche o campo. Sem internet, funciona como um campo comum.
 */
export function CampoSugestao({ api, campo, rotulo, valor, aoMudar, maxLength = 120 }: {
  api: Api;
  campo: 'brand' | 'category';
  rotulo: string;
  valor: string;
  aoMudar: (v: string) => void;
  maxLength?: number;
}) {
  const [sugestoes, setSugestoes] = useState<{ value: string; products: number }[]>([]);
  const [focado, setFocado] = useState(false);
  const ultima = useRef(0);

  useEffect(() => {
    if (!focado) return;
    const pedido = ++ultima.current;
    // Espera a pessoa parar de digitar um instante antes de consultar
    const t = setTimeout(() => {
      api
        .valores(campo, valor.trim())
        .then((r) => pedido === ultima.current && setSugestoes(r.filter((s) => s.value !== valor.trim()).slice(0, 6)))
        .catch(() => pedido === ultima.current && setSugestoes([]));
    }, 250);
    return () => clearTimeout(t);
  }, [api, campo, valor, focado]);

  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={estilos.rotulo}>{rotulo}</Text>
      <TextInput
        accessibilityLabel={rotulo}
        style={estilos.campo}
        value={valor}
        onChangeText={aoMudar}
        onFocus={() => setFocado(true)}
        // Atraso: o toque numa sugestão precisa chegar antes de a lista sumir
        onBlur={() => setTimeout(() => setFocado(false), 200)}
        autoCapitalize="words"
        autoCorrect={false}
        maxLength={maxLength}
      />
      {focado && sugestoes.length ? (
        <View style={estilos.lista}>
          {sugestoes.map((s) => (
            <Pressable
              key={s.value}
              accessibilityRole="button"
              accessibilityLabel={`Usar ${s.value}`}
              onPress={() => {
                aoMudar(s.value);
                setSugestoes([]);
              }}
              style={({ pressed }) => [estilos.item, pressed && { backgroundColor: cores.fundo }]}
            >
              <Text style={estilos.valor} numberOfLines={1}>{s.value}</Text>
              <Text style={estilos.qtd}>{s.products}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const estilos = StyleSheet.create({
  rotulo: { fontSize: 14, color: cores.texto, fontWeight: '600', marginBottom: 4 },
  campo: { minHeight: 48, borderWidth: 1, borderColor: cores.borda, borderRadius: 8, backgroundColor: cores.branco, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: cores.texto },
  lista: { borderWidth: 1, borderColor: cores.borda, borderRadius: 8, backgroundColor: cores.branco, marginTop: 4, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: cores.borda },
  valor: { flex: 1, fontSize: 15, color: cores.texto },
  qtd: { fontSize: 12, color: cores.suave, marginLeft: 8 },
});
